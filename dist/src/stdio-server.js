import { createFrameParser } from "./frame.js";
import { scrubForLog } from "./redact.js";
export async function serveStdio(guard, token) {
    let chain = Promise.resolve();
    const parser = createFrameParser((message) => {
        chain = chain
            .then(async () => {
            const response = await guard.handle(message);
            if (response)
                process.stdout.write(`${JSON.stringify(response)}\n`);
        })
            .catch((error) => {
            const text = error instanceof Error ? error.message : String(error);
            process.stderr.write(`mcd-cooldown: ${scrubForLog(text, token)}\n`);
        });
    }, (error) => {
        process.stderr.write(`mcd-cooldown: ${scrubForLog(error.message, token)}\n`);
    });
    process.stdin.on("data", (chunk) => {
        parser(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    await new Promise((resolve) => {
        process.stdin.on("end", () => {
            void chain.then(() => resolve());
        });
    });
}
//# sourceMappingURL=stdio-server.js.map