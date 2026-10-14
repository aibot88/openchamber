// OpenCode 2's HTTP hook cannot replace the sender. CortexKit uses a loopback
// job bridge to retain the native Gemini driver while owning upstream HTTP.
// This trimmed bridge has no account pool, retries, RPC, TUI or CLI session.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import type { Fetch } from "./google-http.ts";
import { subscriptionResponse } from "./transport.ts";

export function assertLoopbackBypassesProxy(env: NodeJS.ProcessEnv = process.env): void {
  const configured = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some((key) => env[key]);
  const bypass = (env.NO_PROXY || env.no_proxy || "").split(",").map((value) => value.trim());
  if (configured && !bypass.some((value) => value === "*" || value === "127.0.0.1" || value.startsWith("127.0.0.1:"))) {
    throw new Error("The subscription loopback bridge requires 127.0.0.1 in NO_PROXY when a network proxy is configured. No request was dispatched.");
  }
}

export async function startSubscriptionBridge(send: Fetch, options: { env?: NodeJS.ProcessEnv; jobTTL?: number } = {}) {
  type Job = { request: Request; timer: ReturnType<typeof setTimeout>; abort: () => void };
  const queued = new Map<string, Job>();
  const running = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const failures = new Map<string, { error: Error; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;
  let origin = "";
  const ttl = options.jobTTL ?? 60_000;
  const takeFailure = (id: string) => {
    const failure = failures.get(id);
    if (!failure) return undefined;
    clearTimeout(failure.timer); failures.delete(id); return failure.error;
  };
  const forget = (id: string) => {
    const job = queued.get(id);
    if (!job) return;
    clearTimeout(job.timer); job.request.signal.removeEventListener("abort", job.abort); queued.delete(id);
  };
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    const id = /^\/subscription\/([a-f0-9]{64})$/.exec(incoming.url ?? "")?.[1];
    const job = id ? queued.get(id) : undefined;
    if (disposed || incoming.method !== "POST" || incoming.headers.host !== new URL(origin).host ||
      incoming.headers.origin || !id || !job) {
      outgoing.writeHead(404, { "Content-Type": "application/json" }); outgoing.end("{}"); return;
    }
    forget(id);
    const controller = new AbortController();
    running.add(controller);
    const signal = AbortSignal.any([controller.signal, job.request.signal]);
    outgoing.once("close", () => { if (!outgoing.writableFinished) controller.abort(); });
    void (async () => {
      let response: Response;
      try {
        const upstream = await send(new Request(job.request, { signal }));
        response = await subscriptionResponse(upstream, new URL(job.request.url).pathname.endsWith(":streamGenerateContent"));
      } catch {
        // No raw transport exception, request body, project or credential in UI.
        response = Response.json({ error: { code: 502, status: "UNAVAILABLE", message: "Subscription transport failed before a response arrived. No fallback was attempted." } }, { status: 502 });
      }
      const headers = Object.fromEntries(response.headers);
      for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive", "set-cookie", "location"]) delete headers[name];
      outgoing.writeHead(response.status, headers);
      if (!response.body) { outgoing.end(); return; }
      const reader = response.body.getReader();
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          if (!outgoing.write(next.value)) await once(outgoing, "drain", { signal });
        }
      } catch {
        const timer = setTimeout(() => failures.delete(id), ttl);
        timer.unref();
        failures.set(id, { error: new Error("Subscription stream ended with an upstream transport or decoding failure."), timer });
        await reader.cancel().catch(() => {});
      } finally {
        outgoing.end(); reader.releaseLock();
      }
    })().catch(() => outgoing.destroy()).finally(() => running.delete(controller));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  server.unref();
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    pendingJobs: () => queued.size + running.size,
    rewrite(upstream: Request): Request {
      if (disposed) throw new Error("Subscription bridge is closed.");
      assertLoopbackBypassesProxy(options.env);
      upstream.signal.throwIfAborted();
      const id = randomBytes(32).toString("hex");
      const abort = () => forget(id);
      const timer = setTimeout(abort, ttl);
      timer.unref();
      queued.set(id, { request: upstream, timer, abort });
      upstream.signal.addEventListener("abort", abort, { once: true });
      // Neither credentials nor conversation data cross the local HTTP hop.
      return new Request(`${origin}/subscription/${id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
        signal: upstream.signal, redirect: "error",
      });
    },
    adapt(request: Request, response: Response): Response {
      const url = new URL(request.url);
      const id = /^\/subscription\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
      if (url.origin !== origin || !id || !response.body) return response;
      const reader = response.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (!next.done) { controller.enqueue(next.value); return; }
            const failure = takeFailure(id);
            if (failure) controller.error(failure); else controller.close();
          } catch (error) { controller.error(takeFailure(id) ?? error); }
        },
        cancel() { takeFailure(id); return reader.cancel(); },
      }), { status: response.status, headers: response.headers });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of queued.keys()) forget(id);
      for (const controller of running) controller.abort();
      for (const failure of failures.values()) clearTimeout(failure.timer);
      failures.clear();
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await stopped;
    },
  };
}
