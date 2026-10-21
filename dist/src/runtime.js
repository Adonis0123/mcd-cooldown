import { FixtureBackend } from "./mcp/fixtures.js";
import { McpHttpClient } from "./mcp/client.js";
import { loadConfig, resolveHome } from "./config.js";
import { HomeStore } from "./store.js";
import { loadToken } from "./token.js";
import { clockFromEnv } from "./time.js";
import { userCommand } from "./user-command.js";
import { UserError } from "./user-error.js";
export function loadContext(env = process.env) {
    const home = resolveHome(env);
    const loaded = loadConfig(home, env);
    const token = loadToken(home, env);
    const store = new HomeStore(home);
    return {
        home,
        store,
        config: loaded.config,
        warnings: [...loaded.warnings, ...token.warnings],
        token: token.token,
        tokenSource: token.source,
        now: clockFromEnv(env),
    };
}
export function makeCaller(ctx, mock) {
    if (mock)
        return new FixtureBackend();
    if (!ctx.token) {
        throw new UserError(`还没有 Token。先运行 ${userCommand()} token，把 Token 留在本机。不要写进仓库或对话。`, 2);
    }
    return new McpHttpClient({ url: ctx.config.upstreamUrl, token: ctx.token });
}
//# sourceMappingURL=runtime.js.map