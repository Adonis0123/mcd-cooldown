import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./is.js";
import { UserError } from "./user-error.js";
export function cliEntryPath() {
    return fileURLToPath(new URL("./cli.js", import.meta.url));
}
export function shellToken(value) {
    if (value.length > 0 && /^[A-Za-z0-9_./@+:-]+$/.test(value))
        return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function statuslineCommand(cliPath) {
    return `node ${shellToken(cliPath)} statusline`;
}
export function hookCommand(cliPath) {
    return `node ${shellToken(cliPath)} hook`;
}
export function mergeClaudeSettings(existing, cliPath) {
    const settings = existing ? structuredClone(existing) : {};
    const before = JSON.stringify(settings);
    const replacedStatusLine = applyStatusLine(settings, statuslineCommand(cliPath));
    applyStopHook(settings, hookCommand(cliPath));
    return { settings, changed: JSON.stringify(settings) !== before, replacedStatusLine };
}
export function applyClaudeSetup(options) {
    const cliPath = options.cliPath ?? cliEntryPath();
    const dryRun = options.dryRun === true;
    const existed = existsSync(options.settingsPath);
    const existing = existed ? readSettings(options.settingsPath) : null;
    const merged = mergeClaudeSettings(existing, cliPath);
    const json = `${JSON.stringify(merged.settings, null, 2)}\n`;
    if (dryRun || !merged.changed) {
        return {
            json,
            changed: merged.changed,
            wrote: false,
            backupPath: null,
            replacedStatusLine: merged.replacedStatusLine,
            message: describe(options.settingsPath, null, merged.replacedStatusLine, !existed, merged.changed, dryRun),
        };
    }
    const mode = existed ? statSync(options.settingsPath).mode & 0o777 : 0o600;
    let backupPath = null;
    if (existed) {
        backupPath = nextBackupPath(options.settingsPath, options.now ?? new Date());
        copyFileSync(options.settingsPath, backupPath);
    }
    else {
        mkdirSync(dirname(options.settingsPath), { recursive: true });
    }
    writeAtomic(options.settingsPath, json, mode);
    return {
        json,
        changed: true,
        wrote: true,
        backupPath,
        replacedStatusLine: merged.replacedStatusLine,
        message: describe(options.settingsPath, backupPath, merged.replacedStatusLine, !existed, true, false),
    };
}
function readSettings(settingsPath) {
    const raw = readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
    if (!raw.trim())
        throw new UserError(`${settingsPath} 是空文件，已停止，没有改动。`);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new UserError(`无法解析 ${settingsPath}，已停止，没有改动。请先改成合法 JSON。`);
    }
    if (!isRecord(parsed))
        throw new UserError(`${settingsPath} 必须是 JSON 对象，已停止，没有改动。`);
    return parsed;
}
function applyStatusLine(settings, command) {
    const current = settings.statusLine;
    if (isRecord(current) && typeof current.command === "string" && isOurStatusline(current.command)) {
        current.command = command;
        if (typeof current.type !== "string")
            current.type = "command";
        if (current.padding == null)
            current.padding = 0;
        settings.statusLine = current;
        return false;
    }
    const replaced = current != null;
    settings.statusLine = { type: "command", command, padding: 0 };
    return replaced;
}
function applyStopHook(settings, command) {
    if (settings.hooks == null)
        settings.hooks = {};
    if (!isRecord(settings.hooks)) {
        throw new UserError("settings.json 里的 hooks 不是对象，已停止，没有改动。");
    }
    const hooks = settings.hooks;
    if (hooks.Stop == null)
        hooks.Stop = [];
    if (!Array.isArray(hooks.Stop)) {
        throw new UserError("settings.json 里的 hooks.Stop 不是数组，已停止，没有改动。");
    }
    let found = false;
    const visit = (node) => {
        if (Array.isArray(node)) {
            for (const item of node)
                visit(item);
            return;
        }
        if (!isRecord(node))
            return;
        if (typeof node.command === "string" && isOurHook(node.command)) {
            node.command = command;
            if (typeof node.type !== "string")
                node.type = "command";
            found = true;
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === "command")
                continue;
            if (value && typeof value === "object")
                visit(value);
        }
    };
    visit(hooks.Stop);
    if (!found)
        hooks.Stop.push({ hooks: [{ type: "command", command }] });
}
function mentionsCli(command) {
    return command.includes("mcd-cooldown") || command.includes("dist/src/cli.js");
}
function isOurStatusline(command) {
    return mentionsCli(command) && /(^|[\s'"])statusline([\s'"]|$)/.test(command);
}
function isOurHook(command) {
    return mentionsCli(command) && /(^|[\s'"])hook([\s'"]|$)/.test(command);
}
function nextBackupPath(settingsPath, now) {
    const primary = `${settingsPath}.bak`;
    if (!existsSync(primary))
        return primary;
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return `${settingsPath}.${stamp}.bak`;
}
function writeAtomic(path, text, mode) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, path);
}
const REOPEN = "重开 Claude Code 后，状态栏会显示一行短状态。空闲时类似：mcd · 已就绪 · 午饭 12:00 · 常点 鸡薯双全盒。还没选门店时，会提示运行 init。";
export function claudeSetupPresent(settingsPath) {
    if (!existsSync(settingsPath))
        return false;
    let parsed;
    try {
        const raw = readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
        if (!raw.trim())
            return false;
        parsed = JSON.parse(raw);
    }
    catch {
        return false;
    }
    if (!isRecord(parsed))
        return false;
    const status = parsed.statusLine;
    if (isRecord(status) && typeof status.command === "string" && isOurStatusline(status.command))
        return true;
    return containsOurHook(parsed.hooks);
}
function containsOurHook(node) {
    if (Array.isArray(node))
        return node.some((item) => containsOurHook(item));
    if (!isRecord(node))
        return false;
    if (typeof node.command === "string" && isOurHook(node.command))
        return true;
    return Object.values(node).some((value) => value != null && typeof value === "object" && containsOurHook(value));
}
function describe(path, backup, replaced, created, changed, dryRun) {
    if (dryRun)
        return "未写入（--print）。";
    if (!changed)
        return `已经配置好：${path}\n没有重复添加，也没有再次备份。\n${REOPEN}`;
    const lines = [created ? `已写入 ${path}` : `已合并到 ${path}`];
    if (backup)
        lines.push(`备份：${backup}`);
    lines.push("statusLine 和 Stop hook 已指向本机的 mcd-cooldown。");
    if (replaced)
        lines.push("原来的 statusLine 已换成本项目的命令，旧内容在备份里。");
    lines.push(REOPEN);
    return lines.join("\n");
}
//# sourceMappingURL=claude-setup.js.map