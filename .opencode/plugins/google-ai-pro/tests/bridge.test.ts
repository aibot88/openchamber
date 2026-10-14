import { describe, expect, test } from "bun:test";
import { assertLoopbackBypassesProxy, startSubscriptionBridge } from "../bridge.ts";
import { SUBSCRIPTION_ENDPOINT } from "../constants.ts";

function upstream(signal?: AbortSignal) {
  return new Request(`${SUBSCRIPTION_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST", headers: { Authorization: "Bearer fixture-only" },
    body: JSON.stringify({ project: "private-project", request: { contents: [{ text: "private-prompt" }] } }), signal,
  });
}

describe("OpenCode subscription loopback bridge", () => {
  test("keeps OAuth and prompts in memory, streams native events, and executes each ticket only once", async () => {
    let calls = 0;
    const bridge = await startSubscriptionBridge(async (request) => {
      calls++;
      expect(new URL((request as Request).url).origin).toBe(SUBSCRIPTION_ENDPOINT);
      expect((request as Request).headers.get("authorization")).toBe("Bearer fixture-only");
      expect(await (request as Request).json()).toHaveProperty("project", "private-project");
      return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n');
    }, { env: {} });
    try {
      const rewritten = bridge.rewrite(upstream());
      expect(await rewritten.clone().text()).toBe("{}");
      expect([...rewritten.headers.keys()]).toEqual(["content-type"]);
      const response = bridge.adapt(rewritten, await fetch(rewritten));
      expect(await response.text()).toContain('data: {"candidates"');
      expect((await fetch(rewritten.url, { method: "POST", body: "{}" })).status).toBe(404);
      expect(calls).toBe(1);
    } finally { await bridge.dispose(); }
  });

  test("forwards Google license and quota errors with no retries or response rewriting", async () => {
    let calls = 0;
    const message = "You do not have a valid license of this product. (#3501)";
    const bridge = await startSubscriptionBridge(async () => { calls++; return Response.json({ error: { message } }, { status: 403 }); }, { env: {} });
    try {
      const rewritten = bridge.rewrite(upstream());
      const response = await fetch(rewritten);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { message } });
      expect(calls).toBe(1);
    } finally { await bridge.dispose(); }
  });

  test("rejects replay, foreign browser origin, incorrect method and unknown tickets", async () => {
    let calls = 0;
    const bridge = await startSubscriptionBridge(async () => { calls++; return new Response(""); }, { env: {} });
    try {
      const rewritten = bridge.rewrite(upstream());
      expect((await fetch(rewritten.url)).status).toBe(404);
      expect((await fetch(new Request(rewritten, { headers: { Origin: "https://attacker.invalid" } }))).status).toBe(404);
      expect((await fetch(`${bridge.origin}/subscription/${"0".repeat(64)}`, { method: "POST" })).status).toBe(404);
      expect(calls).toBe(0);
    } finally { await bridge.dispose(); }
  });

  test("cancellation releases queued tickets and propagates to upstream work", async () => {
    const controller = new AbortController();
    const bridge = await startSubscriptionBridge(async () => new Response(""), { env: {} });
    try {
      bridge.rewrite(upstream(controller.signal));
      expect(bridge.pendingJobs()).toBe(1);
      controller.abort();
      expect(bridge.pendingJobs()).toBe(0);
      expect(() => bridge.rewrite(upstream(controller.signal))).toThrow();
    } finally { await bridge.dispose(); }
  });

  test("surfaces a failure after headers rather than returning truncated successful output", async () => {
    const bridge = await startSubscriptionBridge(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"response":{"value":1}}\n\n')); },
      pull(controller) { controller.error(new Error("fixture post-header failure")); },
    })), { env: {} });
    try {
      const rewritten = bridge.rewrite(upstream());
      const response = bridge.adapt(rewritten, await fetch(rewritten));
      await expect(response.text()).rejects.toThrow("upstream transport or decoding failure");
    } finally { await bridge.dispose(); }
  });

  test("interrupting a dispatched host request aborts the upstream operation", async () => {
    let received!: () => void;
    let canceled!: () => void;
    const dispatched = new Promise<void>((resolve) => { received = resolve; });
    const stopped = new Promise<void>((resolve) => { canceled = resolve; });
    const bridge = await startSubscriptionBridge(async (input) => {
      const signal = (input as Request).signal;
      received();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => { canceled(); reject(new Error("fixture aborted")); }, { once: true });
      });
    }, { env: {} });
    try {
      const controller = new AbortController();
      const rewritten = bridge.rewrite(upstream(controller.signal));
      const result = fetch(rewritten).catch(() => undefined);
      await dispatched;
      controller.abort();
      await result;
      await stopped;
    } finally { await bridge.dispose(); }
  });

  test("never sends a loopback ticket through an external network proxy", () => {
    expect(() => assertLoopbackBypassesProxy({ HTTPS_PROXY: "http://proxy.invalid:8080" })).toThrow("NO_PROXY");
    expect(() => assertLoopbackBypassesProxy({ HTTP_PROXY: "http://proxy.invalid:8080", NO_PROXY: "localhost" })).toThrow();
    expect(() => assertLoopbackBypassesProxy({ HTTPS_PROXY: "http://proxy.invalid:8080", NO_PROXY: "127.0.0.1,localhost" })).not.toThrow();
  });
});
