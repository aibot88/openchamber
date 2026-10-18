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
    return new Promise<Response>((resolve, reject) => {
      let outgoing: ClientRequest | undefined;
      let proxyAgent: HttpsProxyAgent<string> | undefined;
      let headerTimer: ReturnType<typeof setTimeout> | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let failure: Error | undefined;
      let responded = false;
      let retried = false;
      const fail = (error: Error) => {
        failure ??= error;
        if (retryTimer !== undefined || !outgoing) {
          clearTimeout(retryTimer); retryTimer = undefined; finish(error); return;
        }
        outgoing.destroy(error);
      };
      const abort = () => fail(new Error("Devin request canceled."));
      const teardown = () => {
        clearTimeout(headerTimer); clearTimeout(totalTimer); clearTimeout(retryTimer);
        request.signal.removeEventListener("abort", abort); pending.delete(abort);
        proxyAgent?.destroy(); proxyAgent = undefined; outgoing = undefined;
      };
      const finish = (error: Error) => { teardown(); reject(error); };
      const attempt = () => {
        responded = false;
        // https-proxy-agent can debug-log the constructor URL. Credentials live
        // only in its non-logged CONNECT headers, outside the origin request.
        proxyAgent = proxy ? new HttpsProxyAgent(proxy.origin, { headers: proxyHeaders }) : undefined;
        const settings: RequestOptions & { ALPNProtocols: string[] } = {
          // agent:false gives each request a fresh socket: a pooled keep-alive
          // connection the server already closed fails on write, which surfaced
          // as intermittent transport failures.
          method: "POST", agent: proxyAgent ?? false, ALPNProtocols: ["http/1.1"], headers: {
            "Content-Type": url.pathname === CHAT_PATH ? "application/connect+proto" : "application/proto",
            "Connect-Protocol-Version": "1", "User-Agent": "connect-es/2.0.0",
            "Accept-Encoding": "gzip", "Connect-Accept-Encoding": "gzip",
            "Content-Length": body.length, Authorization: request.headers.get("authorization")!,
          },
        };
        const req = (options.request ?? httpsRequest)(url, settings, (incoming) => {
          responded = true;
          clearTimeout(headerTimer);
          const decoder = incoming.headers["content-encoding"] === "gzip" ? createGunzip() : undefined;
          if (decoder) pipeline(incoming, decoder, () => {});
          const iterator = (decoder ?? incoming)[Symbol.asyncIterator]();
          incoming.setTimeout(options.idleMs ?? 120_000, abort);
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await iterator.next();
                if (next.done) { teardown(); controller.close(); }
                else controller.enqueue(z.instanceof(Uint8Array).parse(next.value));
              } catch (error) {
                teardown();
                const detail = (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : undefined);
                controller.error(new Error(`Devin response body failed${detail ? ` (${detail})` : ""}. No retry was attempted.`, { cause: error }));
              }
            },
            async cancel() { outgoing?.destroy(); await iterator.return?.().catch(() => {}); teardown(); },
          });
          const status = incoming.statusCode ?? 502;
          if (status === 204 || status === 304) { req.destroy(); void iterator.return?.().catch(() => {}); teardown(); resolve(new Response(null, { status })); }
          else resolve(new Response(stream, { status, headers: { "Content-Type": incoming.headers["content-type"] ?? "application/octet-stream" } }));
        });
        outgoing = req;
        req.once("error", (error) => {
          if (outgoing === req) outgoing = undefined;
          clearTimeout(headerTimer);
          const agent = proxyAgent; proxyAgent = undefined; agent?.destroy();
          // A socket that died before any response byte cannot have produced a
          // generation upstream, so exactly one retry is safe: it only rides out
          // transport resets. Deliberate cancels and timeouts set `failure`
          // first, and never retry.
          if (!responded && !retried && !failure) {
            retried = true;
            retryTimer = setTimeout(attempt, 500); retryTimer.unref();
            return;
          }
          // Surface the underlying socket failure (ECONNRESET, EPIPE, proxy
          // CONNECT errors) so repeated failures can be told apart.
          const detail = (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error && error.message !== "Socket closed" ? error.message : undefined);
          finish(failure ?? new Error(`Devin HTTP/1.1 request failed${detail ? ` (${detail})` : ""}${retried ? " after one retry" : ""}. No fallback was attempted.`, { cause: error }));
        });
        // Chat first-byte can legitimately exceed a short deadline on large
        // prompts; the idle budget between stream chunks is the same bound.
        headerTimer = setTimeout(() => fail(new Error("Devin upstream did not send a response in time. No retry was attempted.")), options.headerMs ?? 120_000);
        headerTimer.unref();
        req.end(body);
      };
      const totalTimer = setTimeout(() => fail(new Error("Devin request exceeded its total time limit. No retry was attempted.")), options.totalMs ?? 600_000);
      totalTimer.unref();
      pending.add(abort); request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      attempt();
    });
  };
  return { send, dispose() { disposed = true; for (const abort of pending) abort(); pending.clear(); } };
}
