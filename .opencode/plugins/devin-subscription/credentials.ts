import { z } from "zod";
import type { Credential } from "@opencode/plugin";

// Only the current Devin session-token path, not cloud API keys or old Firebase.
const token = z.string().max(8192).regex(/^devin-session-token\$[A-Za-z0-9._-]{8,}$/);
export function validateToken(input: string): string {
  const parsed = token.safeParse(input);
  if (!parsed.success) throw new Error("A valid Devin Desktop session token is required. Reimport the desktop login; no credential fallback was attempted.");
  return parsed.data;
}
export function connectionToken(credential: Credential.Value | undefined): string {
  if (credential?.type !== "key") throw new Error("Connect Devin subscription before dispatch.");
  return validateToken(credential.key);
}
const sessions = z.array(z.object({ accessToken: token })).length(1);
export function desktopSession(plaintext: string): string {
  try {
    const parsed = sessions.safeParse(JSON.parse(plaintext));
    if (parsed.success) return parsed.data[0].accessToken;
  } catch { /* Never attach parser errors containing decrypted account data. */ }
  throw new Error("Devin Desktop must contain exactly one current session-token login. Sign in in Devin and retry the import.");
}
