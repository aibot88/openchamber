// HTTP/1.1, ordered headers, chunked stream requests and gzip decoding adapted
// from CortexKit's agy-transport.ts. See THIRD_PARTY_NOTICES.md for pinned sources.
// Node owns HTTP parsing and TLS verification; no custom TLS/HTTP parser is used.
import { request as httpsRequest, Agent } from "node:https";
import type { RequestOptions } from "node:https";
import type { ConnectionOptions } from "node:tls";
import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SUBSCRIPTION_ENDPOINT, USER_AGENT } from "./constants.ts";
import type { Fetch } from "./google-http.ts";

const allowedPaths = new Set([
  "/v1internal:generateContent", "/v1internal:streamGenerateContent",
  "/v1internal:fetchAvailableModels",
]);

export function validateSubscriptionURL(url: URL): void {
  if (url.origin !== SUBSCRIPTION_ENDPOINT || url.username || url.password ||
    !allowedPaths.has(url.pathname) || url.hash ||
    (url.search && !(url.pathname === "/v1internal:streamGenerateContent" && url.search === "?alt=sse"))) {
    throw new Error("Unsupported subscription destination. No endpoint or API fallback is permitted.");
  }
}

export function wireHeaders(request: Request, body: Uint8Array): string[] {
  const url = new URL(request.url);
  const framing = url.pathname === "/v1internal:streamGenerateContent"
    ? ["Transfer-Encoding", "chunked"] : ["Content-Length", String(body.byteLength)];
  return [
    "Host", url.host, "User-Agent", USER_AGENT, ...framing,
    "Authorization", request.headers.get("authorization") ?? "",
    "Content-Type", "application/json", "Accept-Encoding", "gzip",
  ];
}

export function proxyFor(hostname: string, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const exclusions = (env.NO_PROXY || env.no_proxy || "").split(",").map((value) => value.trim().toLowerCase());
  const host = hostname.toLowerCase();
  if (exclusions.some((value) => value === "*" || value === host ||
    (value && host.endsWith(`.${value.replace(/^\./, "")}`)))) return undefined;
  const raw = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return undefined;
  let proxy: URL;
  try { proxy = new URL(raw); } catch { throw new Error("Invalid HTTPS proxy configuration."); }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error("This subscription transport requires an HTTP(S) CONNECT proxy; no direct-network fallback was attempted.");
  }
  return proxy;
}

export function createSubscriptionHTTP(options: {
  request?: typeof httpsRequest;
  env?: NodeJS.ProcessEnv;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
} = {}): { fetch: Fetch; dispose: () => void } {
  const send = options.request ?? httpsRequest;
  const agents = new Map<string, Agent | HttpsProxyAgent<string>>();
  const pending = new Set<() => void>();
  let disposed = false;
  const fetcher: Fetch = async (input, init) => {
    if (disposed) throw new Error("Subscription transport is closed.");
    const request = new Request(input, init);
    const url = new URL(request.url);
    validateSubscriptionURL(url);
    if (request.method !== "POST" || !request.headers.get("authorization")?.startsWith("Bearer ")) {
      throw new Error("Subscription transport requires an authenticated POST.");
    }
    request.signal.throwIfAborted();
    const body = Buffer.from(await request.arrayBuffer());
    request.signal.throwIfAborted();
    const proxy = proxyFor(url.hostname, options.env);
    // Do not reuse a connection pool across manually selected OAuth identities.
    // Access-token refresh may start a new pool; inactive old pools are bounded.
    const identity = createHash("sha256").update(request.headers.get("authorization")!).digest("hex");
    const key = `${proxy?.href ?? "direct"}:${identity}`;
    let agent = agents.get(key);
    if (!agent) {
      if (agents.size >= 8) {
        const inactive = [...agents].find(([, candidate]) => Object.values(candidate.sockets).every((sockets) => !sockets?.length));
        if (inactive) { inactive[1].destroy(); agents.delete(inactive[0]); }
      }
      agent = proxy ? new HttpsProxyAgent(proxy, { keepAlive: true, maxSockets: 4, maxFreeSockets: 1 }) :
        new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1 });
      agents.set(key, agent);
    }
    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = () => outgoing.destroy(new Error("Subscription request canceled."));
      const cleanup = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", fail);
        pending.delete(fail);
      };
      const settings: RequestOptions & Pick<ConnectionOptions, "ALPNProtocols"> = {
        method: "POST", headers: wireHeaders(request, body), agent,
        // Do not add Accept, Connection or other fetch-runtime headers.
        setDefaultHeaders: false, ALPNProtocols: ["http/1.1"],
      };
      const outgoing = send(url, settings, (incoming) => {
        clearTimeout(timer);
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          const name = incoming.rawHeaders[i];
          if (!/^(?:content-length|content-encoding|transfer-encoding|connection|keep-alive)$/i.test(name)) {
            headers.append(name, incoming.rawHeaders[i + 1]);
          }
        }
        const gzip = incoming.headers["content-encoding"] === "gzip";
        const decoder = gzip ? createGunzip() : undefined;
        const decoded = decoder ?? incoming;
        if (decoder) pipeline(incoming, decoder, () => {});
        const idle = options.idleTimeoutMs ?? 180_000;
        incoming.setTimeout(idle, () => outgoing.destroy(new Error("Subscription response stalled.")));
        incoming.once("close", cleanup);
        const reader = (Readable.toWeb(decoded) as unknown as ReadableStream<Uint8Array>).getReader();
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { cleanup(); controller.close(); }
              else controller.enqueue(next.value);
            } catch {
              cleanup(); controller.error(new Error("Subscription response body failed."));
            }
          },
          cancel() { cleanup(); outgoing.destroy(); return reader.cancel(); },
        });
        // No redirect following, no retries; Google errors keep their status/body.
        const status = incoming.statusCode ?? 502;
        if (status === 204 || status === 304) {
          incoming.resume(); resolve(new Response(null, { status, headers }));
        } else resolve(new Response(stream, { status, headers }));
      });
      outgoing.once("error", () => {
        cleanup(); reject(new Error("Subscription HTTP/1.1 request failed. No fallback was attempted."));
      });
      timer = setTimeout(() => outgoing.destroy(new Error("Subscription response headers timed out.")), options.headerTimeoutMs ?? 180_000);
      timer.unref();
      pending.add(fail);
      request.signal.addEventListener("abort", fail, { once: true });
      if (request.signal.aborted) fail();
      outgoing.end(body);
    });
  };
  return {
    fetch: fetcher,
    dispose() {
      disposed = true;
      for (const abort of pending) abort();
      for (const agent of agents.values()) agent.destroy();
      agents.clear();
    },
  };
}
