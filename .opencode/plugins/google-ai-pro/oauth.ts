import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import type { Credential } from "@opencode/plugin";
// Public desktop-client configuration from a pinned MIT-licensed package.
// Only constants are imported; its V1 plugin, account pool and logging never run.
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_REDIRECT_URI,
} from "opencode-antigravity-auth-updated/dist/src/constants.js";
import { METHOD_ID } from "./constants.ts";
import { jsonResponse, type Fetch } from "./google-http.ts";
import { resolveProject } from "./project.ts";
export type { Fetch } from "./google-http.ts";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});

async function tokenRequest(parameters: URLSearchParams, fetcher: Fetch, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters,
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
    redirect: "error",
  });
  const parsed = tokenSchema.safeParse(await jsonResponse(response, "Google token exchange"));
  if (!parsed.success) throw new Error("Google token exchange returned an invalid credential.");
  return parsed.data;
}

export function createAuthorization(redirectURI = ANTIGRAVITY_REDIRECT_URI) {
  const verifier = randomBytes(32).toString("base64url");
  // PKCE verifier stays in memory. It is never encoded in the public state URL.
  const state = randomBytes(32).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectURI,
    scope: ANTIGRAVITY_SCOPES.join(" "),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return { url: url.toString(), verifier, state, redirectURI };
}

export function callbackCode(input: string, expectedState: string, redirectURI: string): string {
  const url = new URL(input);
  const redirect = new URL(redirectURI);
  if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) {
    throw new Error("Unexpected OAuth callback address.");
  }
  const state = url.searchParams.get("state") ?? "";
  const actual = Buffer.from(state);
  const expected = Buffer.from(expectedState);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("OAuth state mismatch. Start a new sign-in.");
  }
  if (url.searchParams.has("error")) throw new Error("Google sign-in was declined.");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OAuth callback has no authorization code.");
  return code;
}

export async function exchangeCode(
  code: string,
  authorization: ReturnType<typeof createAuthorization>,
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
): Promise<Credential.OAuth> {
  const token = await tokenRequest(new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    code_verifier: authorization.verifier,
    redirect_uri: authorization.redirectURI,
  }), fetcher, signal);
  if (!token.refresh_token) throw new Error("Google did not issue a refresh token. Sign in again.");
  const projectId = await resolveProject(token.access_token, fetcher, { signal });
  return {
    type: "oauth",
    methodID: METHOD_ID,
    refresh: token.refresh_token,
    access: token.access_token,
    expires: Date.now() + Math.max(0, token.expires_in * 1000 - 60_000),
    metadata: { projectId },
  };
}

export async function refreshCredential(
  credential: Credential.OAuth,
  fetcher: Fetch = fetch,
): Promise<Credential.OAuth> {
  if (credential.methodID !== METHOD_ID) throw new Error("Unexpected Google subscription credential.");
  const token = await tokenRequest(new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: credential.refresh,
  }), fetcher);
  return {
    ...credential,
    access: token.access_token,
    refresh: token.refresh_token ?? credential.refresh,
    expires: Date.now() + Math.max(0, token.expires_in * 1000 - 60_000),
  };
}

export async function startLoopbackAuthorization(options: {
  fetcher?: Fetch;
  redirectURI?: string;
  timeoutMs?: number;
} = {}) {
  const authorization = createAuthorization(options.redirectURI);
  const controller = new AbortController();
  const redirect = new URL(authorization.redirectURI);
  if (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
    throw new Error("OAuth listener must use a loopback address.");
  }
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const received = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.method !== "GET") {
      response.writeHead(405).end("GET required.");
      return;
    }
    try {
      const code = callbackCode(new URL(request.url ?? "/", redirect.origin).toString(), authorization.state, authorization.redirectURI);
      response.end("Authorization received. Return to OpenChamber to check whether sign-in completed.");
      resolveCode(code);
    } catch {
      // A foreign request must not consume or reveal the active attempt.
      response.writeHead(400).end("Invalid authorization callback.");
      const url = new URL(request.url ?? "/", redirect.origin);
      if (url.pathname === redirect.pathname && url.searchParams.get("state") === authorization.state && url.searchParams.has("error")) {
        rejectCode(new Error("Google sign-in was declined."));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirect.port), "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const timeout = setTimeout(() => rejectCode(new Error("Google sign-in timed out.")), options.timeoutMs ?? 300_000);
  server.on("error", () => rejectCode(new Error("Google sign-in listener failed.")));
  const cancel = () => {
    controller.abort();
    rejectCode(new Error("Google sign-in canceled."));
  };
  const callback = received.finally(() => {
    clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
  }).then((code) => exchangeCode(code, authorization, options.fetcher, controller.signal));
  // OpenCode owns this promise; keep cancellation safe before it attaches.
  void callback.catch(() => {});
  return {
    url: authorization.url,
    expiresAt: Date.now() + (options.timeoutMs ?? 300_000),
    callback,
    cancel,
  };
}
