import { UserError } from "./user-error.js";

/** Drop terminal bracketed-paste markers and other control characters. */
export function normalizeHiddenInput(raw: string): string {
  return raw.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/**
 * Read one line from a TTY without echoing it.
 * Callers must not print the returned string.
 */
export function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return Promise.reject(new UserError("当前不是交互终端。把 Token 从标准输入传入。"));
  }
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const previous = stdin.isRaw;
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      if (stdin.isTTY) stdin.setRawMode(Boolean(previous));
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(result ?? "");
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          finish(undefined, normalizeHiddenInput(value));
          return;
        }
        if (char === "\u0003") {
          finish(new UserError("已取消，没有保存 Token。"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    const onEnd = () => finish(undefined, normalizeHiddenInput(value));
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
    stdout.write(prompt);
  });
}
