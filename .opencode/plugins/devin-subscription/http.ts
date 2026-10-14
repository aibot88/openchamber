import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { HttpsProxyAgent } from "https-proxy-agent";
import { z } from "zod";
import { CHAT_PATH, CATALOG_PATH, ORIGIN, MAX_BYTES, type Send } from "./constants.ts";
import { validateToken } from "./credentials.ts";

export function validateDestination(request: Request): URL {
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || ![CHAT_PATH, CATALOG_PATH].includes(url.pathname) ||
    url.search || url.hash || url.username || url.password || request.method !== "POST") {
    throw new Error("Unsupported Devin destination. No endpoint fallback is permitted.");
  }
  const auth = request.headers.get("authorization") ?? "";
  const match = /^Basic (devin-session-token\$[A-Za-z0-9._-]+)-\1$/.exec(auth);
  if (!match) throw new Error("Invalid Devin request authentication.");
  validateToken(match[1]);
  return url;
}

export function proxyFor(env: NodeJS.ProcessEnv): URL | undefined {
  const exclusions = (env.NO_PROXY || env.no_proxy || "").split(",").map((value) => value.trim().toLowerCase());
  if (exclusions.some((value) => value === "*" || value === "server.codeium.com" || value === ".codeium.com" || value === "codeium.com")) return;
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return;
  let proxy: URL;
  try { proxy = new URL(raw); } catch { throw new Error("Invalid Devin HTTPS proxy configuration."); }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new Error("Devin requires an HTTP(S) CONNECT proxy. No direct-network fallback was attempted.");
  return proxy;
}

type RequestSender = (url: URL, options: RequestOptions & { ALPNProtocols: string[] }, callback: (response: IncomingMessage) => void) => ClientRequest;
export function createHTTP(options: { request?: RequestSender; env?: NodeJS.ProcessEnv; headerMs?: number; idleMs?: number; totalMs?: number } = {}) {
  const pending = new Set<() => void>();
  let disposed = false;
  const send: Send = async (request) => {
    if (disposed) throw new Error("Devin transport is closed.");
    const url = validateDestination(request);
    request.signal.throwIfAborted();
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length > MAX_BYTES + 5) throw new Error("Devin request exceeds the size limit.");
    request.signal.throwIfAborted();
    const proxy = proxyFor(options.env ?? process.env);
    let proxyHeaders: { "Proxy-Authorization"?: string } = {};
    if (proxy?.username || proxy?.password) {
      try { proxyHeaders = { "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` }; }
      catch { throw new Error("Invalid Devin proxy credentials."); }
    }
    // https-proxy-agent can debug-log the constructor URL. Credentials live
    // only in its non-logged CONNECT headers, outside the origin request.
    const agent = proxy ? new HttpsProxyAgent(proxy.origin, { headers: proxyHeaders }) : undefined;
    return new Promise<Response>((resolve, reject) => {
      let headerTimer: ReturnType<typeof setTimeout> | undefined;
      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => outgoing.destroy(new Error("Devin request canceled."));
      const cleanup = () => {
        clearTimeout(headerTimer); clearTimeout(totalTimer);
        request.signal.removeEventListener("abort", abort); pending.delete(abort);
        agent?.destroy();
      };
      const settings: RequestOptions & { ALPNProtocols: string[] } = {
        method: "POST", agent, ALPNProtocols: ["http/1.1"], headers: {
          "Content-Type": url.pathname === CHAT_PATH ? "application/connect+proto" : "application/proto",
          "Connect-Protocol-Version": "1", "User-Agent": "connect-es/2.0.0",
          "Accept-Encoding": "gzip", "Connect-Accept-Encoding": "gzip",
          "Content-Length": body.length, Authorization: request.headers.get("authorization")!,
        },
      };
      const outgoing = (options.request ?? httpsRequest)(url, settings, (incoming) => {
        clearTimeout(headerTimer);
        const decoder = incoming.headers["content-encoding"] === "gzip" ? createGunzip() : undefined;
        if (decoder) pipeline(incoming, decoder, () => {});
        const iterator = (decoder ?? incoming)[Symbol.asyncIterator]();
        incoming.setTimeout(options.idleMs ?? 120_000, abort);
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) { cleanup(); controller.close(); }
              else controller.enqueue(z.instanceof(Uint8Array).parse(next.value));
            } catch { cleanup(); controller.error(new Error("Devin response body failed. No retry was attempted.")); }
          },
          async cancel() { outgoing.destroy(); await iterator.return?.().catch(() => {}); cleanup(); },
        });
        const status = incoming.statusCode ?? 502;
        if (status === 204 || status === 304) { outgoing.destroy(); void iterator.return?.().catch(() => {}); cleanup(); resolve(new Response(null, { status })); }
        else resolve(new Response(stream, { status, headers: { "Content-Type": incoming.headers["content-type"] ?? "application/octet-stream" } }));
      });
      outgoing.once("error", () => { cleanup(); reject(new Error("Devin HTTP/1.1 request failed. No fallback was attempted.")); });
      headerTimer = setTimeout(abort, options.headerMs ?? 30_000); headerTimer.unref();
      totalTimer = setTimeout(abort, options.totalMs ?? 600_000); totalTimer.unref();
      pending.add(abort); request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      outgoing.end(body);
    });
  };
  return { send, dispose() { disposed = true; for (const abort of pending) abort(); pending.clear(); } };
}
