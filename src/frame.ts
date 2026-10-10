export function createFrameParser(
  onMessage: (message: unknown) => void,
  onError: (error: Error) => void,
): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 1_000_000) {
      buffer = Buffer.alloc(0);
      onError(new Error("MCP 消息过大"));
      return;
    }
    while (buffer.length > 0) {
      while (buffer.length > 0 && (buffer[0] === 0x0a || buffer[0] === 0x0d)) {
        buffer = buffer.subarray(1);
      }
      if (buffer.length === 0) return;
      const head = buffer.subarray(0, 20).toString("utf8").toLowerCase();
      if (head.startsWith("content-length")) {
        const headerEnd = findHeaderEnd(buffer);
        if (!headerEnd) return;
        const header = buffer.subarray(0, headerEnd.index).toString("utf8");
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match?.[1]) {
          buffer = Buffer.alloc(0);
          onError(new Error("Content-Length 无效"));
          return;
        }
        const length = Number(match[1]);
        const start = headerEnd.index + headerEnd.sep;
        if (buffer.length < start + length) return;
        const body = buffer.subarray(start, start + length).toString("utf8");
        buffer = buffer.subarray(start + length);
        parseOne(body, onMessage, onError);
        continue;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      parseOne(line, onMessage, onError);
    }
  };
}

function findHeaderEnd(buffer: Buffer): { index: number; sep: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) return { index: lf, sep: 2 };
  if (lf === -1) return { index: crlf, sep: 4 };
  return crlf < lf ? { index: crlf, sep: 4 } : { index: lf, sep: 2 };
}

function parseOne(body: string, onMessage: (message: unknown) => void, onError: (error: Error) => void): void {
  try {
    onMessage(JSON.parse(body) as unknown);
  } catch (error) {
    onError(error instanceof Error ? error : new Error("无法解析 MCP 消息"));
  }
}
