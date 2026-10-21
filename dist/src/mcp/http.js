import { createServer } from "node:http";
export async function listenLoopback(handler, port = 0) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("没有拿到监听端口");
    return {
        port: address.port,
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
}
export async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
export function sendJson(res, status, body, session) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (session)
        headers["Mcp-Session-Id"] = session;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
}
export function sendSse(res, body, session) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Mcp-Session-Id": session,
    });
    res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
}
export function isRpcRequest(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=http.js.map