#!/usr/bin/env node
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { flagBool, flagList, flagString, parseArgs } from "./args.js";
import { applyClaudeSetup, claudeSetupPresent } from "./claude-setup.js";
import { assertHomeOutside, resolveHome } from "./config.js";
import { assertConfigHidesToken, formatInitSummary, runInit } from "./init-config.js";
import { confirmPending, denyPending } from "./confirm.js";
import { formatStatusline, preparePlan, rememberSession, runHook } from "./cooldown.js";
import { dismissMeal, mealCommand, mealStatusFor, spawnDesktopNotify } from "./meals.js";
import { renderDemo } from "./demo.js";
import { fixtureStoreRefusal, runDoctor } from "./doctor.js";
import { Guard } from "./guard.js";
import { fixtureHttpHandler } from "./mcp/fixture-http.js";
import { isRpcRequest, listenLoopback, readBody, sendJson } from "./mcp/http.js";
import { formatAuditLine, formatPendingLine } from "./present.js";
import { scrubForLog } from "./redact.js";
import { loadContext, makeCaller } from "./runtime.js";
import { serveStdio } from "./stdio-server.js";
import { readHiddenLine } from "./secret-input.js";
import { clockFromEnv } from "./time.js";
import { clearTokenFile, saveTokenFile } from "./token.js";
import { userCommand } from "./user-command.js";
import { UserError } from "./user-error.js";
import { VERSION } from "./version.js";
import { watchOrder } from "./watch.js";
function helpText() {
    const cmd = userCommand();
    return `mcd-cooldown ${VERSION}
额度用完，先核价。本地网关拦住写操作，确认后才提交。

三步开始
  1. npm install -g github:Adonis0123/mcd-cooldown
  2. ${cmd} token
  3. ${cmd} init && ${cmd} setup claude

其他命令
  ${cmd} plan [--mock] [--allow-quiet]
  ${cmd} confirm <请求号> [--allow-quiet] [--retry]
  ${cmd} deny <请求号>
  ${cmd} doctor [--mock] [--city 城市 --keyword 关键词]
  ${cmd} pending  ${cmd} log  ${cmd} watch <订单号>
  ${cmd} meals on | lunch 12:00 | dinner 18:30 | weekends on
  ${cmd} ate | later | skip
  ${cmd} guard | serve [--port 39217] | statusline | hook [--no-prepare] [--mock]
  ${cmd} init [--mock] [--meals] [--menu-all] [--city 城市 --keyword 关键词 --store 门店 --item 餐品]
  ${cmd} setup claude [--print]  ${cmd} token --clear
  ${cmd} demo | mock [--port 39217]

Token 用 ${cmd} token 写到本机 ~/.mcd-cooldown/token，权限 0600，不会回显。
环境变量 MCD_MCP_TOKEN 优先，但只对当前终端有效。
init 只读查询门店和菜单，不会下单。
非麦当劳官方产品。默认只核价，不会自动下单。`;
}
async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (flagBool(parsed.flags, "help") || parsed.command === "help") {
        process.stdout.write(`${helpText()}\n`);
        return;
    }
    if (parsed.command === "version") {
        process.stdout.write(`${VERSION}\n`);
        return;
    }
    if (parsed.command === "demo") {
        process.stdout.write(`${renderDemo()}\n`);
        return;
    }
    if (parsed.command === "token") {
        await runTokenCommand(parsed);
        return;
    }
    const env = process.env;
    const ctx = loadContext(env);
    if (parsed.command !== "mock")
        assertHomeOutside(ctx.home, process.cwd());
    const now = () => clockFromEnv(env);
    switch (parsed.command) {
        case "init": {
            ctx.store.ensure();
            const file = join(ctx.home, "config.json");
            if (existsSync(file))
                throw new UserError(`配置已存在：${file}`);
            const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
            const city = flagString(parsed.flags, "city");
            const keyword = flagString(parsed.flags, "keyword");
            const storePick = flagString(parsed.flags, "store");
            const itemPicks = flagList(parsed.flags, "item");
            const mealsFlag = flagBool(parsed.flags, "meals");
            const guided = interactive || Boolean(city?.trim() || keyword?.trim() || storePick?.trim() || itemPicks.length > 0);
            if (!guided) {
                const hint = !flagBool(parsed.flags, "mock") && !ctx.token
                    ? `还没有 Token。先运行 ${userCommand()} token，把 Token 留在本机。\n`
                    : "";
                throw new UserError(`${hint}交互终端里运行 ${userCommand()} init，按编号选择门店和常点餐品。\n非交互环境：${userCommand()} init --city 城市 --keyword 关键词 --store 门店 --item 餐品编码\n没有写入配置。`);
            }
            const caller = makeCaller(ctx, flagBool(parsed.flags, "mock"));
            const prompter = interactive ? openPrompter() : undefined;
            const scrub = (text) => scrubForLog(text, ctx.token);
            try {
                const result = await runInit({
                    caller,
                    city,
                    keyword,
                    store: storePick,
                    items: itemPicks,
                    mealsEnabled: mealsFlag,
                    askMeals: interactive && !mealsFlag,
                    interactive,
                    menuAll: flagBool(parsed.flags, "menu-all"),
                    prompter,
                    now: now(),
                    emit: (line) => process.stdout.write(`${scrub(line)}\n`),
                });
                assertConfigHidesToken(result.configText, ctx.token);
                const tmp = `${file}.tmp`;
                writeFileSync(tmp, result.configText, { mode: 0o600 });
                renameSync(tmp, file);
                process.stdout.write(`${scrub(formatInitSummary(file, result))}\n`);
                const claudeSettings = join(homedir(), ".claude", "settings.json");
                if (!claudeSetupPresent(claudeSettings)) {
                    process.stdout.write(`下一步：${userCommand()} setup claude\n`);
                }
            }
            finally {
                prompter?.close();
            }
            return;
        }
        case "setup": {
            if (parsed.positionals[0] !== "claude" || parsed.positionals.length > 1) {
                throw new UserError(`用法：${userCommand()} setup claude [--print]`);
            }
            const dryRun = flagBool(parsed.flags, "print") || flagBool(parsed.flags, "dry-run");
            const settingsPath = flagString(parsed.flags, "settings") ?? join(homedir(), ".claude", "settings.json");
            const result = applyClaudeSetup({ settingsPath, dryRun });
            process.stdout.write(dryRun ? result.json : `${result.message}\n`);
            return;
        }
        case "doctor": {
            const mock = flagBool(parsed.flags, "mock");
            const caller = makeCaller(ctx, mock);
            const report = await runDoctor({
                caller,
                token: ctx.token,
                tokenSource: ctx.tokenSource,
                warnings: ctx.warnings,
                config: ctx.config,
                workspace: process.cwd(),
                configHome: ctx.home,
                city: flagString(parsed.flags, "city"),
                keyword: flagString(parsed.flags, "keyword"),
                mock,
            });
            process.stdout.write(`${report.lines.join("\n")}\n`);
            if (!report.ok)
                throw new UserError("doctor 未通过", 2);
            return;
        }
        case "guard": {
            if (process.stdin.isTTY) {
                throw new UserError("guard 由 MCP 客户端通过标准输入启动，不要在交互终端里直接运行");
            }
            const caller = makeCaller(ctx, false);
            const guard = new Guard({ caller, store: ctx.store, config: ctx.config, token: ctx.token, now });
            await serveStdio(guard, ctx.token);
            return;
        }
        case "serve":
            await serveHttp(ctx, portOf(parsed.flags), false);
            return;
        case "mock":
            await serveHttp(ctx, portOf(parsed.flags), true);
            return;
        case "plan": {
            const mock = flagBool(parsed.flags, "mock");
            if (!mock) {
                const fixtureStore = fixtureStoreRefusal(ctx.config.store?.storeCode);
                if (fixtureStore)
                    throw new UserError(fixtureStore);
            }
            const caller = makeCaller(ctx, mock);
            const session = rememberSession(ctx.store, {}, now());
            const plan = await preparePlan({
                caller,
                store: ctx.store,
                config: ctx.config,
                now: now(),
                session,
                allowQuiet: flagBool(parsed.flags, "allow-quiet"),
            });
            process.stdout.write(`${plan.headline}\n${plan.hint}\n${plan.note}\n`);
            return;
        }
        case "statusline": {
            const raw = parseStdin(await readStdinText());
            const session = rememberSession(ctx.store, raw, now());
            const line = formatStatusline({
                now: now(),
                config: ctx.config,
                session,
                plan: ctx.store.readPlan(),
                pickup: ctx.store.readPickup(),
                pickupStaleMs: 120_000,
                meal: mealStatusFor(now(), ctx.config, ctx.store),
                tokenMissing: !ctx.token,
            });
            process.stdout.write(`${line}\n`);
            return;
        }
        case "hook": {
            const raw = parseStdin(await readStdinText());
            const mock = flagBool(parsed.flags, "mock");
            const noPrepare = flagBool(parsed.flags, "no-prepare");
            const caller = !noPrepare && (mock || flagBool(parsed.flags, "prepare") || ctx.token) ? makeCaller(ctx, mock) : null;
            const text = await runHook({
                raw,
                caller,
                store: ctx.store,
                config: ctx.config,
                now: now(),
                prepare: caller != null,
                notify: ctx.config.meals.notify ? spawnDesktopNotify : undefined,
                tokenMissing: !ctx.token && !mock,
            });
            if (text)
                process.stdout.write(`${text}\n`);
            return;
        }
        case "confirm": {
            const id = parsed.positionals[0];
            if (!id)
                throw new UserError(`用法：${userCommand()} confirm <请求号>`);
            const caller = makeCaller(ctx, flagBool(parsed.flags, "mock"));
            const text = await confirmPending(ctx.store, caller, ctx.config, id, {
                allowQuiet: flagBool(parsed.flags, "allow-quiet"),
                retry: flagBool(parsed.flags, "retry"),
                now: now(),
                token: ctx.token,
            });
            process.stdout.write(`${text}\n`);
            return;
        }
        case "deny": {
            const id = parsed.positionals[0];
            if (!id)
                throw new UserError(`用法：${userCommand()} deny <请求号>`);
            process.stdout.write(`${denyPending(ctx.store, id, now())}\n`);
            return;
        }
        case "pending": {
            const rows = ctx.store.listPending();
            if (rows.length === 0) {
                process.stdout.write("没有待确认请求。\n");
                return;
            }
            for (const row of rows) {
                process.stdout.write(`${formatPendingLine(row, ctx.config.meals.timezone)}\n`);
            }
            return;
        }
        case "log": {
            const events = ctx.store.readAudit().slice(-20);
            if (events.length === 0) {
                process.stdout.write("还没有调用记录。\n");
                return;
            }
            for (const event of events) {
                process.stdout.write(`${formatAuditLine(event, ctx.config.meals.timezone, ctx.token)}\n`);
            }
            return;
        }
        case "meals": {
            const sub = parsed.positionals[0];
            if (sub === "ate" || sub === "later" || sub === "skip") {
                process.stdout.write(`${dismissMeal(ctx.store, ctx.config, now(), sub, parsed.positionals[1])}\n`);
                return;
            }
            process.stdout.write(`${mealCommand(ctx.home, parsed.positionals)}\n`);
            return;
        }
        case "ate":
        case "later":
        case "skip": {
            process.stdout.write(`${dismissMeal(ctx.store, ctx.config, now(), parsed.command, parsed.positionals[0])}\n`);
            return;
        }
        case "watch": {
            const orderId = parsed.positionals[0] ?? ctx.store.readPickup()?.orderId;
            if (!orderId)
                throw new UserError(`用法：${userCommand()} watch <订单号>`);
            const caller = makeCaller(ctx, flagBool(parsed.flags, "mock"));
            process.stdout.write(`${await watchOrder(caller, ctx.store, orderId, now())}\n`);
            return;
        }
        default:
            throw new UserError(`未知命令 ${parsed.command}\n\n${helpText()}`);
    }
}
async function runTokenCommand(parsed) {
    if (parsed.positionals.length > 0) {
        throw new UserError(`Token 不要写在命令后面。请运行 ${userCommand()} token，或从标准输入传入。`);
    }
    const home = resolveHome(process.env);
    assertHomeOutside(home, process.cwd());
    if (flagBool(parsed.flags, "clear")) {
        const cleared = clearTokenFile(home);
        process.stdout.write(cleared.removed ? `已删除 ${cleared.path}。\n` : `本机没有 token 文件：${cleared.path}\n`);
        return;
    }
    const raw = process.stdin.isTTY ? await readHiddenLine("粘贴 Token 后回车：") : await readStdinText();
    const saved = saveTokenFile(home, raw);
    process.stdout.write(`已写入 ${saved.path}，长度 ${saved.length}，权限 0600。\n`);
}
function portOf(flags) {
    const host = flagString(flags, "host");
    if (host && host !== "127.0.0.1" && host !== "localhost") {
        throw new UserError("只监听 127.0.0.1，避免把网关暴露到局域网");
    }
    const raw = flagString(flags, "port") ?? "39217";
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new UserError("端口无效");
    return port;
}
async function serveHttp(ctx, port, mock) {
    if (mock) {
        const server = await listenLoopback(fixtureHttpHandler(), port);
        process.stderr.write(`样例 MCP 监听 ${server.url}（不是麦当劳官方实时数据，只接受本机连接）\n`);
        await new Promise((resolve) => {
            process.once("SIGINT", () => {
                void server.close().then(() => resolve());
            });
        });
        return;
    }
    const caller = makeCaller(ctx, false);
    const guard = new Guard({
        caller,
        store: ctx.store,
        config: ctx.config,
        token: ctx.token,
        now: () => clockFromEnv(process.env),
    });
    const server = await listenLoopback(async (req, res) => {
        if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" });
            res.end("mcd-cooldown 使用 POST");
            return;
        }
        const raw = await readBody(req);
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch {
            sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid json" } });
            return;
        }
        if (!isRpcRequest(message)) {
            sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
            return;
        }
        const response = await guard.handle(message);
        if (!response) {
            res.writeHead(202);
            res.end();
            return;
        }
        sendJson(res, 200, response, "mcd-cooldown-local");
    }, port);
    process.stderr.write(`mcd-cooldown 监听 ${server.url}（仅本机，Token 不进入客户端配置）\n`);
    await new Promise((resolve) => {
        process.once("SIGINT", () => {
            void server.close().then(() => resolve());
        });
    });
}
async function readStdinText() {
    if (process.stdin.isTTY)
        return "";
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
}
function parseStdin(text) {
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        throw new UserError("标准输入不是 JSON");
    }
}
function openPrompter() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return {
        ask: (prompt) => new Promise((resolve) => {
            rl.question(prompt, (answer) => resolve(answer));
        }),
        close: () => rl.close(),
    };
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const secret = process.env.MCD_MCP_TOKEN ?? null;
    process.stderr.write(`${scrubForLog(message, secret)}\n`);
    const code = error instanceof UserError ? error.exitCode : 1;
    process.exit(code);
});
//# sourceMappingURL=cli.js.map