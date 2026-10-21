const VALUE_FLAGS = new Set(["port", "city", "keyword", "host", "store", "settings"]);
const MULTI_FLAGS = new Set(["item"]);
export function parseArgs(argv) {
    const flags = {};
    const positionals = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i] ?? "";
        if (arg === "--") {
            positionals.push(...argv.slice(i + 1));
            break;
        }
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const body = arg.slice(2);
        const eq = body.indexOf("=");
        if (eq >= 0) {
            const key = body.slice(0, eq);
            const value = body.slice(eq + 1);
            if (MULTI_FLAGS.has(key))
                pushMulti(flags, key, value);
            else
                flags[key] = value;
            continue;
        }
        if (VALUE_FLAGS.has(body) || MULTI_FLAGS.has(body)) {
            const next = argv[i + 1];
            if (next == null || next.startsWith("--")) {
                throw new Error(`--${body} 需要一个值`);
            }
            if (MULTI_FLAGS.has(body))
                pushMulti(flags, body, next);
            else
                flags[body] = next;
            i += 1;
            continue;
        }
        flags[body] = true;
    }
    return { command: positionals[0] ?? "help", positionals: positionals.slice(1), flags };
}
function pushMulti(flags, key, value) {
    const current = flags[key];
    const list = Array.isArray(current) ? current : [];
    list.push(value);
    flags[key] = list;
}
export function flagString(flags, name) {
    const value = flags[name];
    if (typeof value === "string")
        return value;
    if (Array.isArray(value))
        return value[0];
    return undefined;
}
export function flagList(flags, name) {
    const value = flags[name];
    if (Array.isArray(value))
        return value;
    if (typeof value === "string" && value.trim())
        return [value];
    return [];
}
export function flagBool(flags, name) {
    return flags[name] === true || flags[name] === "true";
}
//# sourceMappingURL=args.js.map