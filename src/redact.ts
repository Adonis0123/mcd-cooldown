const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PHONE = /\b1[3-9]\d{9}\b/g;

export function scrubSecrets(input: string, secret: string | null): string {
  let out = input;
  if (secret && secret.length >= 8 && out.includes(secret)) {
    out = out.split(secret).join("[redacted]");
  }
  return out.replace(BEARER, "Bearer [redacted]");
}

export function scrubForLog(input: string, secret: string | null): string {
  return scrubSecrets(input, secret).replace(PHONE, (phone) => `${phone.slice(0, 3)}****${phone.slice(7)}`);
}

export function containsSecret(value: unknown, secret: string | null): boolean {
  const text = JSON.stringify(value) ?? "";
  if (BEARER.test(text)) {
    BEARER.lastIndex = 0;
    return true;
  }
  BEARER.lastIndex = 0;
  return Boolean(secret && secret.length >= 8 && text.includes(secret));
}
