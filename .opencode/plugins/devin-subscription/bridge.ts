// One-use in-memory HTTP jobs keep native OpenCode tool execution and permissions.
// Derived from the fork's Google bridge; no credentials cross the local hop.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import type { Send } from "./constants.ts";
import type { ChatPayload } from "./request.ts";
import { subscriptionResponse } from "./response.ts";

export function assertLoopbackProxy(env: NodeJS.ProcessEnv): void {
  const proxy = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some((name) => env[name]);
  const bypass = (env.NO_PROXY || env.no_proxy || "").split(",").map((value) => value.trim());
  if (proxy && !bypass.some((value) => value === "*" || value === "127.0.0.1" || value.startsWith("127.0.0.1:"))) {
    throw new Error("The Devin loopback bridge requires 127.0.0.1 in NO_PROXY. No request was dispatched.");
  }
}

export async function startBridge(send: Send, options: { env?: NodeJS.ProcessEnv; ttlMs?: number } = {}) {
  type Job = { request: Request; input: ChatPayload; beforeSend?: () => Promise<void>; timer: ReturnType<typeof setTimeout>; abort: () => void };
  const queued = new Map<string, Job>();
  const running = new Set<AbortController>();
  const sockets = new Set<Socket>();
  const failures = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let origin = "";
  const ttl = options.ttlMs ?? 60_000;
  const forget = (id: string) => {
    const job = queued.get(id);
    if (!job) return;
    clearTimeout(job.timer); job.request.signal.removeEventListener("abort", job.abort); queued.delete(id);
  };
  const takeFailure = (id: string) => {
    const timer = failures.get(id);
    if (!timer) return false;
    clearTimeout(timer); failures.delete(id); return true;
  };
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    const id = /^\/devin\/([a-f0-9]{64})$/.exec(incoming.url ?? "")?.[1];
    const job = id ? queued.get(id) : undefined;
    if (disposed || incoming.method !== "POST" || incoming.headers.host !== new URL(origin).host ||
      incoming.headers.origin || !id || !job) { outgoing.writeHead(404); outgoing.end("{}"); return; }
    forget(id);
    const controller = new AbortController();
    running.add(controller);
    const signal = AbortSignal.any([controller.signal, job.request.signal]);
    outgoing.once("close", () => { if (!outgoing.writableFinished) controller.abort(); });
    void (async () => {
      let response: Response;
      try {
        await job.beforeSend?.();
        signal.throwIfAborted();
        response = await subscriptionResponse(await send(new Request(job.request, { signal })), job.input);
      }
      catch (error) {
        // Authored failures name their cause and never carry upstream content.
        // Anything foreign keeps the generic message: a platform error could
        // echo a destination or payload fragment the user should not see.
        const message = error instanceof Error && error.message.includes("Devin")
          ? error.message
          : "Devin transport failed before a response arrived. No retry or fallback was attempted.";
        response = Response.json({ error: { message } }, { status: 502 });
      }
      outgoing.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json" });
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
        const timer = setTimeout(() => failures.delete(id), ttl); timer.unref(); failures.set(id, timer);
        await reader.cancel().catch(() => {});
      } finally { reader.releaseLock(); outgoing.end(); }
    })().catch(() => outgoing.destroy()).finally(() => running.delete(controller));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); server.unref();
  // The bound address is known to be TCP after listen(0, '127.0.0.1').
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, pendingJobs: () => queued.size + running.size,
    rewrite(job: { request: Request; input: ChatPayload; beforeSend?: () => Promise<void> }): Request {
      if (disposed || queued.size + running.size >= 64) throw new Error("Devin bridge is closed or at capacity.");
      assertLoopbackProxy(options.env ?? process.env); job.request.signal.throwIfAborted();
      const id = randomBytes(32).toString("hex");
      const abort = () => forget(id);
      const timer = setTimeout(abort, ttl); timer.unref();
      queued.set(id, { ...job, timer, abort }); job.request.signal.addEventListener("abort", abort, { once: true });
      return new Request(`${origin}/devin/${id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: "{}", signal: job.request.signal, redirect: "error" });
    },
    adapt(request: Request, response: Response): Response {
      const url = new URL(request.url);
      const id = /^\/devin\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
      if (url.origin !== origin || !id || !response.body) return response;
      const reader = response.body.getReader();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (!next.done) controller.enqueue(next.value);
            else if (takeFailure(id)) controller.error(new Error("Devin stream or native tool validation failed. No retry was attempted."));
            else controller.close();
          } catch { takeFailure(id); controller.error(new Error("Devin local response stream failed.")); }
        },
        cancel() { takeFailure(id); return reader.cancel(); },
      }), { status: response.status, headers: response.headers });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of queued.keys()) forget(id);
      for (const controller of running) controller.abort();
      for (const timer of failures.values()) clearTimeout(timer);
      failures.clear();
      const close = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await close;
    },
  };
}
