export function charWidth(code: number): number {
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(input: string): number {
  let width = 0;
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    width += charWidth(code);
  }
  return width;
}

export function renderBox(title: string, rows: string[]): string {
  const contentWidth = Math.max(stringWidth(title) + 2, ...rows.map((row) => stringWidth(row)), 8);
  const inner = contentWidth + 2;
  const label = `─ ${title} `;
  const top = `┌${label}${"─".repeat(Math.max(0, inner - stringWidth(label)))}┐`;
  const body = rows.map((row) => `│ ${row}${" ".repeat(Math.max(0, contentWidth - stringWidth(row)))} │`);
  const bottom = `└${"─".repeat(inner)}┘`;
  return [top, ...body, bottom].join("\n");
}
