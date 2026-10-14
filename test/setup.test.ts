import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { flagBool, flagList, flagString, parseArgs } from "../src/args.js";
import { applyClaudeSetup, hookCommand, mergeClaudeSettings, statuslineCommand } from "../src/claude-setup.js";
import { CATALOG } from "../src/catalog.js";
import { loadConfig, placeholderConfig } from "../src/config.js";
import {
  assertConfigHidesToken,
  assertInitTool,
  extractMeals,
  formatInitSummary,
  formatMenuChoices,
  nextMealReservationDate,
  unavailableMealHint,
  BREAKFAST_HOUR_HINT,
  BEFORE_NEXT_MEAL_HINT,
  pickByToken,
  runInit,
  type MenuItem,
} from "../src/init-config.js";
import { FixtureBackend } from "../src/mcp/fixtures.js";
import { MEAL_UNAVAILABLE_HINT, unwrapPayload } from "../src/mcp/parse.js";
import type { ToolCaller } from "../src/mcp/types.js";
import { orderArgsFromConfig } from "../src/order-flow.js";
import { zonedInstant } from "../src/time.js";
import { userCommand } from "../src/user-command.js";
import { UserError } from "../src/user-error.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end();
  });
}

function envOf(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, MCD_HOME: join(home, "mcd"), MCD_MCP_TOKEN: "", MCD_NOW: "2026-10-12T03:50:00.000Z" };
}

const quietInit = {
  mealsEnabled: false,
  askMeals: false,
  interactive: false,
};

test("flags accept a store and repeated meal items", () => {
  const parsed = parseArgs(["init", "--city", "上海", "--keyword", "南京西路", "--store", "1", "--item", "A", "--item=B", "--meals", "--mock"]);
  assert.equal(parsed.command, "init");
  assert.equal(flagString(parsed.flags, "city"), "上海");
  assert.equal(flagString(parsed.flags, "keyword"), "南京西路");
  assert.equal(flagString(parsed.flags, "store"), "1");
  assert.deepEqual(flagList(parsed.flags, "item"), ["A", "B"]);
  assert.equal(flagBool(parsed.flags, "meals"), true);
  assert.equal(flagBool(parsed.flags, "mock"), true);
  const setup = parseArgs(["setup", "claude", "--dry-run", "--settings", "/tmp/claude-settings.json"]);
  assert.deepEqual(setup.positionals, ["claude"]);
  assert.equal(flagBool(setup.flags, "dry-run"), true);
  assert.equal(flagString(setup.flags, "settings"), "/tmp/claude-settings.json");
  assert.throws(() => parseArgs(["init", "--city"]), /--city 需要一个值/);
});

test("init looks up a store and meals with the mock MCP and never orders", async () => {
  const backend = new FixtureBackend();
  const lines: string[] = [];
  const now = zonedInstant(2026, 10, 13, 9, 50, "Asia/Shanghai");
  const result = await runInit({
    caller: backend,
    city: "示例市",
    keyword: "示例路",
    store: "SAMPLE-STORE",
    items: ["SAMPLE-001", "SAMPLE-001", "1,2"],
    ...quietInit,
    mealsEnabled: true,
    now,
    emit: (line) => lines.push(line),
  });
  assert.equal(lines.length, 0);
  assert.deepEqual(
    backend.calls.map((call) => call.name),
    ["query-nearby-stores", "query-meals"],
  );
  assert.deepEqual(backend.calls[0]?.args, { searchType: 2, beType: 1, city: "示例市", keyword: "示例路" });
  assert.equal(backend.calls[1]?.args.storeCode, "SAMPLE-STORE");
  assert.equal(backend.calls[1]?.args.beType, 1);
  assert.equal(backend.calls[1]?.args.orderType, 1);
  assert.equal(backend.calls[1]?.args.reservationDate, "2026-10-13 12:00");
  assert.equal("beCode" in (backend.calls[1]?.args ?? {}), false);
  for (const tool of CATALOG) {
    if (tool.effect === "write") assert.equal(backend.called(tool.name), 0, tool.name);
  }
  assert.equal(backend.called("calculate-price"), 0);
  assert.deepEqual(
    result.items.map((item) => item.code),
    ["SAMPLE-001", "SAMPLE-002"],
  );
  const home = mkdtempSync(join(tmpdir(), "mcd-init-"));
  writeFileSync(join(home, "config.json"), result.configText, { mode: 0o600 });
  const loaded = loadConfig(home, {}).config;
  assert.equal(loaded.store?.storeCode, "SAMPLE-STORE");
  assert.equal(loaded.store?.beCode, undefined);
  assert.equal(loaded.store?.beType, 1);
  assert.equal(loaded.store?.takeWayCode, "eat-in");
  assert.equal(loaded.meals.enabled, true);
  assert.equal(placeholderConfig(loaded), false);
  assert.equal(result.configText.includes("YOUR_"), false);
  assert.equal(orderArgsFromConfig(loaded)?.beCode, undefined);
  assert.match(formatInitSummary(join(home, "config.json"), result), /没有下单/);
  assert.match(formatInitSummary(join(home, "config.json"), result), /2026-10-13 12:00/);
});

test("interactive answers pick a numbered store and meal", async () => {
  const backend = new FixtureBackend();
  const answers = ["示例市", "两家", "9", "2", "", "n"];
  const prompts: string[] = [];
  const lines: string[] = [];
  const result = await runInit({
    caller: backend,
    mealsEnabled: false,
    askMeals: true,
    interactive: true,
    emit: (line) => lines.push(line),
    prompter: {
      async ask(prompt: string) {
        prompts.push(prompt);
        const next = answers.shift();
        if (next == null) throw new Error(`unexpected prompt ${prompt}`);
        return next;
      },
    },
  });
  assert.equal(answers.length, 0);
  assert.match(prompts[0] ?? "", /城市/);
  assert.match(prompts[1] ?? "", /关键词/);
  assert.match(prompts[2] ?? "", /序号/);
  assert.match(prompts[3] ?? "", /序号/);
  assert.match(prompts[4] ?? "", /餐品/);
  assert.match(prompts[5] ?? "", /午饭/);
  assert.match(lines.join("\n"), /麦当劳示例二店/);
  assert.equal(result.store.storeCode, "SAMPLE-STORE-2");
  assert.deepEqual(
    result.items.map((item) => item.code),
    ["SAMPLE-001"],
  );
  assert.equal(result.mealsEnabled, false);
  assert.deepEqual(
    backend.calls.map((call) => call.name),
    ["query-nearby-stores", "query-meals"],
  );
});

test("non-interactive init prints choices and does not write when a pick is missing", async () => {
  const lines: string[] = [];
  const backend = new FixtureBackend();
  await assert.rejects(
    () =>
      runInit({
        caller: backend,
        city: "示例市",
        keyword: "两家",
        ...quietInit,
        emit: (line) => lines.push(line),
      }),
    (error: unknown) => {
      assert.ok(error instanceof UserError);
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /--store/);
      return true;
    },
  );
  assert.match(lines.join("\n"), /SAMPLE-STORE-2/);
  assert.equal(backend.called("query-meals"), 0);
  assert.equal(backend.called("create-order"), 0);

  const menuLines: string[] = [];
  await assert.rejects(
    () =>
      runInit({
        caller: new FixtureBackend(),
        city: "示例市",
        keyword: "示例路",
        store: "1",
        ...quietInit,
        emit: (line) => menuLines.push(line),
      }),
    /--item/,
  );
  assert.match(menuLines.join("\n"), /SAMPLE-002/);
  assert.equal(menuLines.join("\n").includes("麦当劳示例餐厅"), false);
});

test("init stops on an empty store list or a closed menu and still does not order", async () => {
  const empty = new FixtureBackend();
  await assert.rejects(
    () => runInit({ caller: empty, city: "示例市", keyword: "无门店", store: "1", items: ["1"], ...quietInit }),
    /0 家门店/,
  );
  assert.deepEqual(
    empty.calls.map((call) => call.name),
    ["query-nearby-stores"],
  );

  const closed = new FixtureBackend();
  await assert.rejects(
    () => runInit({ caller: closed, city: "示例市", keyword: "打烊", store: "1", items: ["1"], ...quietInit }),
    /不营业/,
  );
  assert.deepEqual(
    closed.calls.map((call) => call.name),
    ["query-nearby-stores", "query-meals"],
  );
  assert.equal(closed.called("create-order"), 0);
});

test("init refuses write tools and a config that contains the token", () => {
  assert.throws(() => assertInitTool("create-order"), /没有下单/);
  assert.throws(() => assertInitTool("calculate-price"), /拒绝调用/);
  assert.doesNotThrow(() => assertInitTool("query-nearby-stores"));
  assert.throws(() => assertConfigHidesToken("code sample-token-value", "sample-token-value"), /Token/);
  assert.doesNotThrow(() => assertConfigHidesToken("SAMPLE-STORE", "sample-token-value"));
  const menu: MenuItem[] = [
    { code: "1", name: "编码是 1", price: null, category: null },
    { code: "SAMPLE-002", name: "第二份", price: "8.00", category: null },
  ];
  assert.equal(pickByToken(menu, "1", (item) => item.code)?.name, "编码是 1");
  assert.equal(pickByToken(menu, "2", (item) => item.code)?.code, "SAMPLE-002");
});

test("menu extraction keeps category order and falls back to a flat product list", async () => {
  const backend = new FixtureBackend();
  const payload = unwrapPayload(await backend.callTool("query-meals", { storeCode: "SAMPLE-STORE", beType: 1, orderType: 1 }));
  const meals = extractMeals(payload);
  assert.deepEqual(
    meals.map((item) => item.code),
    ["SAMPLE-001", "SAMPLE-002"],
  );
  assert.equal(meals[0]?.name, "示例套餐");
  assert.equal(meals[0]?.price, "36.50");
  assert.equal(meals[0]?.category, "人气热卖");
  const flat = extractMeals({ productList: [{ productCode: "FLAT-1", productName: "散点", currentPrice: "9" }] });
  assert.equal(flat[0]?.code, "FLAT-1");
  assert.equal(flat[0]?.name, "散点");
});

test("menu category headers collapse newlines onto one line", () => {
  const text = formatMenuChoices([
    { code: "1001", name: "板烧鸡腿堡", price: "22.00", category: "鸡肉汉堡\n/卷" },
    { code: "1002", name: "麦辣鸡腿堡", price: "20.00", category: "鸡肉汉堡\r\n/卷" },
    { code: "2001", name: "玉米杯", price: "8.00", category: "小食  拼盘" },
    { code: "2002", name: "苹果片", price: null, category: "小食\n拼盘" },
  ]);
  const lines = text.split("\n");
  assert.equal(lines[0], "鸡肉汉堡/卷");
  assert.equal(lines.filter((line) => line === "鸡肉汉堡/卷").length, 1);
  assert.match(lines[1] ?? "", /^1\. 板烧鸡腿堡/);
  assert.equal(lines.includes("小食拼盘") || lines.includes("小食 拼盘"), true);
  assert.equal(text.includes("\n/卷"), false);
  const spaced = lines.find((line) => line.startsWith("小食"));
  assert.equal(spaced, "小食 拼盘");
});

test("60006 wording follows the next lunch and dinner clock", () => {
  const morning = zonedInstant(2026, 10, 14, 8, 30, "Asia/Shanghai");
  const breakfast = unavailableMealHint(morning);
  assert.equal(breakfast, BREAKFAST_HOUR_HINT);
  assert.match(breakfast, /早餐时段/);
  assert.equal(breakfast.includes("换一份"), false);

  const nearLunch = zonedInstant(2026, 10, 14, 11, 50, "Asia/Shanghai");
  assert.equal(unavailableMealHint(nearLunch), MEAL_UNAVAILABLE_HINT);

  const afternoon = zonedInstant(2026, 10, 14, 15, 0, "Asia/Shanghai");
  const beforeDinner = unavailableMealHint(afternoon, {
    timezone: "Asia/Shanghai",
    lunch: "12:00",
    dinner: "18:30",
    prepMinutes: 20,
    lingerMinutes: 45,
  });
  assert.equal(beforeDinner, BEFORE_NEXT_MEAL_HINT);
  assert.equal(beforeDinner.includes("早餐时段"), false);

  const custom = unavailableMealHint(zonedInstant(2026, 10, 14, 16, 50, "Asia/Shanghai"), {
    timezone: "Asia/Shanghai",
    lunch: "11:30",
    dinner: "17:00",
    prepMinutes: 15,
    lingerMinutes: 30,
  });
  assert.equal(custom, MEAL_UNAVAILABLE_HINT);
});

test("a caller that rejects write tools can still complete init", async () => {
  const backend = new FixtureBackend();
  const caller: ToolCaller = {
    listTools: () => backend.listTools(),
    async callTool(name, args) {
      if (name === "create-order" || name === "calculate-price" || name === "draw-lottery") {
        throw new Error(`refused ${name}`);
      }
      return backend.callTool(name, args);
    },
  };
  const result = await runInit({
    caller,
    city: "示例市",
    keyword: "示例路",
    store: "1",
    items: ["SAMPLE-002"],
    ...quietInit,
  });
  assert.equal(result.store.storeCode, "SAMPLE-STORE");
  assert.equal(result.items[0]?.code, "SAMPLE-002");
});

test("morning init queries the next lunch menu and skips breakfast items", async () => {
  const morning = zonedInstant(2026, 10, 13, 9, 50, "Asia/Shanghai");
  const noon = zonedInstant(2026, 10, 13, 12, 0, "Asia/Shanghai");
  const afternoon = zonedInstant(2026, 10, 13, 13, 0, "Asia/Shanghai");
  const evening = zonedInstant(2026, 10, 13, 20, 0, "Asia/Shanghai");
  assert.equal(nextMealReservationDate(morning), "2026-10-13 12:00");
  assert.equal(nextMealReservationDate(noon), "2026-10-13 18:30");
  assert.equal(nextMealReservationDate(afternoon), "2026-10-13 18:30");
  assert.equal(nextMealReservationDate(evening), "2026-10-14 12:00");
  assert.ok(zonedInstant(2026, 10, 13, 12, 0, "Asia/Shanghai").getTime() > morning.getTime());

  const picked = await runInit({
    caller: daypartCaller(),
    city: "示例市",
    keyword: "示例路",
    store: "1",
    items: ["1"],
    ...quietInit,
    now: morning,
  });
  assert.equal(picked.reservationDate, "2026-10-13 12:00");
  assert.equal(picked.items[0]?.code, "LUNCH-001");
  assert.equal(picked.items[0]?.name, "示例巨无霸");
  assert.equal(picked.called.includes("calculate-price"), false);
  assert.equal(picked.called.includes("create-order"), false);

  const later = await runInit({
    caller: daypartCaller(),
    city: "示例市",
    keyword: "示例路",
    store: "SAMPLE-STORE",
    items: ["LUNCH-001"],
    ...quietInit,
    now: evening,
  });
  assert.equal(later.reservationDate, "2026-10-14 12:00");
  assert.equal(later.items[0]?.code, "LUNCH-001");
});

test("unresolved init picks still print the list, resolved picks stay quiet", async () => {
  const storeLines: string[] = [];
  await assert.rejects(
    () =>
      runInit({
        caller: new FixtureBackend(),
        city: "示例市",
        keyword: "两家",
        store: "NO-SUCH",
        items: ["1"],
        ...quietInit,
        emit: (line) => storeLines.push(line),
      }),
    /NO-SUCH/,
  );
  assert.match(storeLines.join("\n"), /SAMPLE-STORE-2/);

  const menuLines: string[] = [];
  await assert.rejects(
    () =>
      runInit({
        caller: new FixtureBackend(),
        city: "示例市",
        keyword: "示例路",
        store: "SAMPLE-STORE",
        items: ["NO-ITEM"],
        ...quietInit,
        emit: (line) => menuLines.push(line),
      }),
    /NO-ITEM/,
  );
  assert.match(menuLines.join("\n"), /示例套餐/);
  assert.equal(menuLines.join("\n").includes("示例路 1 号"), false);
});

test("copy-paste commands use mcd-cooldown only when it is on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcd-bin-"));
  const bin = join(dir, "mcd-cooldown");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  const linked = userCommand({ ...process.env, PATH: `${dir}${delimiter}/usr/bin` });
  assert.equal(linked, "mcd-cooldown");
  const empty = mkdtempSync(join(tmpdir(), "mcd-empty-path-"));
  const missing = userCommand({ ...process.env, PATH: empty });
  assert.notEqual(missing, "mcd-cooldown");
  assert.match(missing, /^node /);
  assert.match(missing, /cli\.js$/);
});

function daypartCaller(): ToolCaller {
  const stores = new FixtureBackend();
  return {
    listTools: () => stores.listTools(),
    async callTool(name, args) {
      if (name !== "query-meals") return stores.callTool(name, args);
      const reservation = typeof args.reservationDate === "string" ? args.reservationDate : "";
      const hour = Number(reservation.slice(11, 13));
      const mealtime = hour >= 11 && hour <= 20;
      const code = mealtime ? "LUNCH-001" : "BF-001";
      const mealName = mealtime ? "示例巨无霸" : "示例麦满分";
      const data = {
        categories: [{ name: mealtime ? "正餐" : "早餐", meals: [{ code }] }],
        meals: { [code]: { name: mealName, currentPrice: "22.00" } },
      };
      const body = { success: true, code: 200, message: "ok", data, sample: true };
      return { structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  };
}

test("claude setup merges, backs up, and stays idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcd-claude-"));
  const settingsPath = join(dir, "settings.json");
  const cliPath = "/opt/mcd-cooldown/dist/src/cli.js";
  const original = `${JSON.stringify(
    {
      theme: "dark",
      statusLine: { type: "command", command: "echo hi", padding: 2 },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stay" }] }] },
    },
    null,
    2,
  )}\n`;
  writeFileSync(settingsPath, original);
  const dry = applyClaudeSetup({ settingsPath, cliPath, dryRun: true });
  assert.equal(dry.wrote, false);
  assert.equal(dry.backupPath, null);
  assert.equal(readFileSync(settingsPath, "utf8"), original);
  assert.equal(JSON.parse(dry.json).statusLine.command, statuslineCommand(cliPath));

  const first = applyClaudeSetup({ settingsPath, cliPath });
  assert.equal(first.wrote, true);
  assert.equal(first.backupPath, `${settingsPath}.bak`);
  assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), original);
  assert.equal(existsSync(`${settingsPath}.tmp`), false);
  const merged = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    theme: string;
    statusLine: { command: string; padding: number };
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  assert.equal(merged.theme, "dark");
  assert.equal(merged.statusLine.command, statuslineCommand(cliPath));
  assert.equal(merged.statusLine.padding, 0);
  assert.equal(merged.hooks.Stop.length, 2);
  assert.match(JSON.stringify(merged), /echo stay/);
  assert.match(first.message, /原来的 statusLine/);

  const second = applyClaudeSetup({ settingsPath, cliPath });
  assert.equal(second.changed, false);
  assert.equal(second.wrote, false);
  assert.equal(second.backupPath, null);
  assert.match(second.message, /没有重复添加/);
  assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), original);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop.length, 2);

  const moved = applyClaudeSetup({
    settingsPath,
    cliPath: "/new/mcd-cooldown/dist/src/cli.js",
    now: new Date("2026-10-12T01:44:00.000Z"),
  });
  assert.equal(moved.backupPath, `${settingsPath}.20261012T014400Z.bak`);
  assert.equal(readFileSync(`${settingsPath}.bak`, "utf8"), original);
  const updated = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: { Stop: unknown[] } };
  assert.equal(updated.hooks.Stop.length, 2);
  assert.match(JSON.stringify(updated), /\/new\/mcd-cooldown\/dist\/src\/cli\.js hook/);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).statusLine.command, statuslineCommand("/new/mcd-cooldown/dist/src/cli.js"));
});

test("claude setup creates a new file, quotes spaced paths, and refuses invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcd-claude-new-"));
  const settingsPath = join(dir, "nested", "settings.json");
  const created = applyClaudeSetup({ settingsPath, cliPath: "/tmp/my project/dist/src/cli.js" });
  assert.equal(created.wrote, true);
  assert.equal(created.backupPath, null);
  assert.match(created.message, /已写入/);
  const body = JSON.parse(readFileSync(settingsPath, "utf8")) as { statusLine: { command: string }; hooks: { Stop: unknown[] } };
  assert.equal(body.statusLine.command, "node '/tmp/my project/dist/src/cli.js' statusline");
  assert.equal(hookCommand("/tmp/my project/dist/src/cli.js"), "node '/tmp/my project/dist/src/cli.js' hook");
  assert.equal(body.hooks.Stop.length, 1);
  const again = mergeClaudeSettings(JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>, "/tmp/my project/dist/src/cli.js");
  assert.equal(again.changed, false);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ nope");
  assert.throws(() => applyClaudeSetup({ settingsPath: broken, cliPath: "/opt/mcd-cooldown/dist/src/cli.js" }), /无法解析/);
  assert.equal(readFileSync(broken, "utf8"), "{ nope");
  assert.equal(existsSync(`${broken}.bak`), false);

  const odd = join(dir, "odd.json");
  writeFileSync(odd, JSON.stringify({ hooks: "nope" }));
  assert.throws(() => applyClaudeSetup({ settingsPath: odd, cliPath: "/opt/mcd-cooldown/dist/src/cli.js" }), /hooks 不是对象/);
  assert.equal(existsSync(`${odd}.bak`), false);
});

test("prepare compiles the cli, and the quick start no longer asks for a hand edit", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: { prepare: string; build: string } };
  assert.match(pkg.scripts.prepare, /tsc/);
  assert.match(pkg.scripts.build, /tsc/);
  assert.equal(existsSync(cli), true);
  assert.equal(readFileSync(cli, "utf8").split("\n")[0], "#!/usr/bin/env node");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /## 三步开始/);
  const quick = readme.slice(readme.indexOf("## 三步开始"), readme.indexOf("## 它做什么"));
  assert.match(quick, /npm install && npm link/);
  assert.match(quick, /mcd-cooldown init && mcd-cooldown setup claude/);
  assert.deepEqual(quick.match(/^\d+\. /gm), ["1. ", "2. ", "3. "]);
  assert.equal(readme.includes("node dist/src/cli.js"), false);
  assert.match(readme, /dist\/src\/cli\.js statusline/);
  assert.equal(readme.includes("把 YOUR_ 开头的占位换成"), false);
});

test("cli init --mock writes the picked store and meals without ordering", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-init-"));
  const env = envOf(home);
  const configPath = join(env.MCD_HOME ?? "", "config.json");
  const bare = await run(["init"], env);
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /--city/);
  assert.equal(existsSync(configPath), false);

  const listed = await run(["init", "--mock", "--city", "示例市", "--keyword", "示例路"], env);
  assert.equal(listed.code, 2, listed.stderr);
  assert.match(listed.stdout, /SAMPLE-STORE/);
  assert.match(listed.stderr, /--store/);
  assert.equal(existsSync(configPath), false);

  const missingToken = await run(["init", "--city", "示例市", "--keyword", "示例路", "--store", "1", "--item", "1"], env);
  assert.notEqual(missingToken.code, 0);
  assert.match(missingToken.stderr, /Token/);
  assert.equal(existsSync(configPath), false);

  const wrote = await run(
    ["init", "--mock", "--meals", "--city", "示例市", "--keyword", "示例路", "--store", "SAMPLE-STORE", "--item", "SAMPLE-001", "--item", "2"],
    env,
  );
  assert.equal(wrote.code, 0, wrote.stderr);
  assert.match(wrote.stdout, /没有下单/);
  assert.match(wrote.stdout, /2026-10-12 12:00/);
  assert.equal(wrote.stdout.includes("人气热卖"), false);
  assert.equal(wrote.stdout.includes("示例路 1 号"), false);
  assert.equal(wrote.stdout.includes("create-order"), false);
  assert.equal(existsSync(`${configPath}.tmp`), false);
  assert.equal(statSync(configPath).mode & 0o077, 0);
  const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
    meals: { enabled: boolean };
    store: { storeCode: string; beCode?: string; beType: number };
    usual: { items: Array<{ productCode: string; quantity: number }> };
  };
  assert.equal(saved.store.storeCode, "SAMPLE-STORE");
  assert.equal(saved.store.beCode, undefined);
  assert.equal(saved.store.beType, 1);
  assert.equal(saved.meals.enabled, true);
  assert.deepEqual(
    saved.usual.items.map((item) => item.productCode),
    ["SAMPLE-001", "SAMPLE-002"],
  );
  assert.equal(JSON.stringify(saved).includes("YOUR_"), false);

  const again = await run(["init", "--mock", "--city", "示例市", "--keyword", "示例路", "--store", "1", "--item", "1"], env);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /配置已存在/);
});

test("cli setup claude is idempotent and --print does not write", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcd-cli-claude-"));
  const env = envOf(home);
  const settingsPath = join(home, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify({ model: "local", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stay" }] }] } }, null, 2)}\n`);
  const printed = await run(["setup", "claude", "--print", "--settings", join(home, "missing.json")], env);
  assert.equal(printed.code, 0, printed.stderr);
  assert.equal(existsSync(join(home, "missing.json")), false);
  const preview = JSON.parse(printed.stdout) as { statusLine: { command: string } };
  assert.equal(preview.statusLine.command, `node ${cli} statusline`);

  const dry = await run(["setup", "claude", "--dry-run", "--settings", settingsPath], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(existsSync(`${settingsPath}.bak`), false);
  assert.match(readFileSync(settingsPath, "utf8"), /"model": "local"/);

  const first = await run(["setup", "claude", "--settings", settingsPath], env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /备份/);
  assert.match(readFileSync(`${settingsPath}.bak`, "utf8"), /echo stay/);
  const body = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    model: string;
    statusLine: { command: string };
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  assert.equal(body.model, "local");
  assert.equal(body.statusLine.command, `node ${cli} statusline`);
  assert.equal(body.hooks.Stop[0]?.hooks[0]?.command, "echo stay");
  assert.equal(body.hooks.Stop[1]?.hooks[0]?.command, `node ${cli} hook`);

  const second = await run(["setup", "claude", "--settings", settingsPath], env);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /没有重复添加/);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop.length, 2);

  const help = await run(["help"], env);
  assert.match(help.stdout, /setup claude/);
  assert.match(help.stdout, /不会下单/);
});
