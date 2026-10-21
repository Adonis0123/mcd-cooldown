import { scrubSecrets } from "../redact.js";
import { UserError } from "../user-error.js";
import { assertTokenUrl } from "../url-policy.js";
import { VERSION } from "../version.js";
import { isRecord } from "../is.js";
import { parseMcpHttpBody } from "./parse.js";
export class UpstreamError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "UpstreamError";
        this.status = status;
    }
}
export class McpHttpClient {
    sessionId = null;
    ready = false;
    nextId = 1;
    fetchImpl;
    timeoutMs;
    url;
    token;
    constructor(options) {
        if (!options.token || options.token.length < 8)
            throw new UserError("调用麦当劳 MCP 需要本机 Token");
        this.url = assertTokenUrl(options.url).toString();
        this.token = options.token;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 20_000;
    }
    async listTools() {
        const tools = [];
        let cursor;
        do {
            const result = await this.rpc("tools/list", cursor ? { cursor } : {});
            if (!isRecord(result) || !Array.isArray(result.tools)) {
                throw new UpstreamError("tools/list 没有返回工具列表", 200);
            }
            for (const tool of result.tools) {
                if (!isRecord(tool) || typeof tool.name !== "string")
                    continue;
                const item = { name: tool.name };
                if (typeof tool.description === "string")
                    item.description = tool.description;
                if (isRecord(tool.inputSchema))
                    item.inputSchema = tool.inputSchema;
                tools.push(item);
            }
            cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
        } while (cursor);
        return tools;
    }
    async callTool(name, args) {
        const result = await this.rpc("tools/call", { name, arguments: args });
        if (!isRecord(result))
            throw new UpstreamError(`${name} 没有返回结果`, 200);
        const content = Array.isArray(result.content)
            ? result.content.flatMap((item) => {
                if (!isRecord(item) || typeof item.type !== "string")
                    return [];
                const entry = { type: item.type };
                if (typeof item.text === "string")
                    entry.text = scrubSecrets(item.text, this.token);
                return [entry];
            })
            : [{ type: "text", text: scrubSecrets(JSON.stringify(result), this.token) }];
        const toolResult = { content };
        if (result.isError === true)
            toolResult.isError = true;
        if (result.structuredContent !== undefined)
            toolResult.structuredContent = result.structuredContent;
        return toolResult;
    }
    async rpc(method, params, attempt = 0) {
        await this.ensureSession();
        const id = this.nextId++;
        const response = await this.post({ jsonrpc: "2.0", id, method, params });
        if (response.status === 404 && attempt < 1) {
            this.ready = false;
            this.sessionId = null;
            return this.rpc(method, params, attempt + 1);
        }
        return this.readResult(response);
    }
    async ensureSession() {
        if (this.ready)
            return;
        const response = await this.post({
            jsonrpc: "2.0",
            id: this.nextId++,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "mcd-cooldown", version: VERSION },
            },
        });
        this.readResult(response);
        this.ready = true;
        try {
            await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
        }
        catch {
            // 个别服务对通知回空响应或 202。初始化已经成功时，不因此中断。
        }
    }
    readResult(response) {
        if (response.status === 401 || response.status === 403) {
            throw new UpstreamError(this.authMessage(response.body), response.status);
        }
        if (response.status === 429) {
            throw new UpstreamError("请求过于频繁（429）。麦当劳 MCP 每个 Token 每分钟最多 600 次。", 429);
        }
        if (response.status === 202 || !response.body.trim())
            return null;
        if (response.status >= 400) {
            throw new UpstreamError(scrubSecrets(`麦当劳 MCP 返回 ${response.status}：${response.body.slice(0, 300)}`, this.token), response.status);
        }
        let parsed;
        try {
            parsed = parseMcpHttpBody(response.contentType, response.body);
        }
        catch {
            throw new UpstreamError("麦当劳 MCP 返回了无法解析的内容", response.status);
        }
        if (!parsed)
            return null;
        if (parsed.error) {
            throw new UpstreamError(scrubSecrets(parsed.error.message || "MCP 调用失败", this.token), response.status);
        }
        return parsed.result;
    }
    authMessage(body) {
        const detail = scrubSecrets(body.trim().slice(0, 180), this.token);
        const suffix = detail ? `：${detail}` : "";
        return `麦当劳 MCP 拒绝了 Token（401/403）${suffix}。请在本机检查 MCD_MCP_TOKEN，不要把 Token 贴到对话里。`;
    }
    async post(message) {
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
            Authorization: `Bearer ${this.token}`,
            "User-Agent": `mcd-cooldown/${VERSION}`,
        };
        if (this.sessionId)
            headers["Mcp-Session-Id"] = this.sessionId;
        let response;
        try {
            response = await this.fetchImpl(this.url, {
                method: "POST",
                headers,
                body: JSON.stringify(message),
                redirect: "error",
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
            if (/redirect/i.test(`${messageText} ${cause}`)) {
                throw new UpstreamError("上游返回了重定向，已拒绝跟随，Token 不会被带到别的地址。", 0);
            }
            throw new UpstreamError(`连接麦当劳 MCP 失败：${scrubSecrets(messageText, this.token)}`, 0);
        }
        const session = response.headers.get("mcp-session-id");
        if (session)
            this.sessionId = session;
        const body = await response.text();
        return { status: response.status, contentType: response.headers.get("content-type") ?? "", body };
    }
}
//# sourceMappingURL=client.js.map