import { createFrameParser } from "./frame.js";
import { Guard } from "./guard.js";
import type { RpcRequest } from "./mcp/types.js";
import { scrubForLog } from "./redact.js";

export async function serveStdio(guard: Guard, token: string | null): Promise<void> {
  let chain = Promise.resolve();
  const parser = createFrameParser(
    (message) => {
      chain = chain
        .then(async () => {
          const response = await guard.handle(message as RpcRequest);
          if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
        })
        .catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          process.stderr.write(`mcd-cooldown: ${scrubForLog(text, token)}\n`);
        });
    },
    (error) => {
      process.stderr.write(`mcd-cooldown: ${scrubForLog(error.message, token)}\n`);
    },
  );
  process.stdin.on("data", (chunk: Buffer | string) => {
    parser(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => {
      void chain.then(() => resolve());
    });
  });
}
