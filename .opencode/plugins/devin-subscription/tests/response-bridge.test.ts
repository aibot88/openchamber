import { expect, test } from "bun:test";
import { bytes, integer, text } from "../protobuf.ts";
import { envelope } from "../connect.ts";
import { subscriptionResponse } from "../response.ts";
import { startBridge, assertLoopbackProxy } from "../bridge.ts";
import { ORIGIN, CHAT_PATH } from "../constants.ts";
import type { ChatPayload } from "../request.ts";

const input: ChatPayload = { model: "fixture-model-1", stream: true, messages: [{ role: "user", content: "Continue" }],
  tools: [{ type: "function", function: { name: "fixture_confirm", parameters: { type: "object" } } }] };
const success = () => envelope(Buffer.from("{}"), 2);
const finish = () => envelope(integer(5, 2));
const tool = (id?: string, name?: string, args?: string) => envelope(bytes(6, Buffer.concat([
  ...(id === undefined ? [] : [text(1, id)]), ...(name === undefined ? [] : [text(2, name)]), ...(args === undefined ? [] : [text(3, args)]),
])));
const response = (...parts: Uint8Array[]) => new Response(new Uint8Array(Buffer.concat(parts)), { headers: { "Content-Type": "application/connect+proto" } });
const job = (signal?: AbortSignal) => ({ input, request: new Request(ORIGIN + CHAT_PATH, { method: "POST", headers: { Authorization: "Basic synthetic-only" }, body: "SYNTHETIC CONVERSATION", signal }) });

test("decodes text, thinking, fragmented native tool arguments and cached token usage", async () => {
  const wire = response(envelope(Buffer.concat([text(3, "answer🙂"), text(9, "thinking"), bytes(7, Buffer.concat([integer(2, 3), integer(3, 4), integer(4, 5), integer(5, 6)]))]), 1),
    tool("call-original", "fixture_confirm", '{"descrip'), tool(undefined, undefined, 'tion":"参数","limit":1}'), finish(), success());
  const result = await (await subscriptionResponse(wire, input)).text();
  expect(result).toContain('"content":"answer🙂"'); expect(result).toContain('"reasoning_content":"thinking"');
  expect(result).toContain('"id":"call-original"'); expect(result).toContain('"finish_reason":"tool_calls"');
  expect(result).toContain('"prompt_tokens":14'); expect(result).toContain('"total_tokens":18'); expect(result.endsWith("data: [DONE]\n\n")).toBe(true);
  expect((result.match(/"tool_calls":\[/g) ?? []).length).toBe(1);
  const toolChunk = result.split("\n").find((line) => line.includes('"tool_calls":['));
  expect(JSON.parse(JSON.parse(toolChunk!.slice(6)).choices[0].delta.tool_calls[0].function.arguments)).toEqual({ description: "参数", limit: 1 });
});
test.each([response(tool("id", "unknown", "{}"), finish(), success()), response(tool("id", undefined, "{}"), finish(), success()), response(tool("id", "fixture_confirm", "[]"), finish(), success()), response(tool("id", "fixture_confirm", '{"partial'), finish(), success()), response(tool(undefined, "fixture_confirm", "{}"), finish(), success()), response(envelope(text(3, "partial")), finish())])("invalid, undeclared, nameless or incomplete output fails without repair", async (wire) => {
  await expect((await subscriptionResponse(wire, input)).text()).rejects.toThrow("validation failed");
});
test.each([2, 3, 4])("every observed upstream stop enum marks completion (finish=%s)", async (code) => {
  const result = await (await subscriptionResponse(response(envelope(text(3, "text")), envelope(integer(5, code)), success()), input)).text();
  expect(result).toContain('"finish_reason":"stop"');
});
test("an empty completion carrying a stop signal finishes instead of failing", async () => {
  const result = await (await subscriptionResponse(response(finish(), success()), input)).text();
  expect(result).toContain('"finish_reason":"stop"'); expect(result.endsWith("data: [DONE]\n\n")).toBe(true);
});
test("upstream-reported invalid tool arguments become an empty object", async () => {
  const reported = envelope(bytes(6, Buffer.concat([text(1, "call-bad"), text(2, "fixture_confirm"), text(4, '{"broken'), text(5, "syntax error")])));
  const result = await (await subscriptionResponse(response(reported, finish(), success()), input)).text();
  const toolChunk = result.split("\n").find((line) => line.includes('"tool_calls":['));
  expect(JSON.parse(JSON.parse(toolChunk!.slice(6)).choices[0].delta.tool_calls[0].function.arguments)).toEqual({});
});
test("output at the caller's cap reports finish_reason length", async () => {
  const usage = envelope(bytes(7, Buffer.concat([integer(2, 10), integer(3, 4)])));
  const result = await (await subscriptionResponse(response(envelope(text(3, "full")), usage, finish(), success()), { ...input, max_tokens: 4 })).text();
  expect(result).toContain('"finish_reason":"length"');
});
test("valid tools are withheld if a later trailer refuses the request", async () => {
  const adapted = await subscriptionResponse(response(tool("id", "fixture_confirm", "{}"), finish(), envelope(Buffer.from('{"error":{"code":"permission_denied","message":"PRIVATE-SERVER-DATA"}}'), 2)), input);
  const reader = adapted.body!.getReader();
  const chunks: string[] = [];
  try { for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(new TextDecoder().decode(next.value)); } } catch (error) { expect(String(error)).not.toContain("PRIVATE-SERVER-DATA"); }
  expect(chunks.join("")).not.toContain("tool_calls"); expect(chunks.join("")).not.toContain("[DONE]");
});
test("HTTP refusals keep status but never echo upstream content", async () => {
  const adapted = await subscriptionResponse(new Response("PRIVATE-SERVER-DATA", { status: 403 }), input);
  expect(adapted.status).toBe(403); expect(await adapted.text()).not.toContain("PRIVATE-SERVER-DATA");
});
test("response cancellation releases an upstream reader blocked waiting for data", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; } });
  const adapted = await subscriptionResponse(new Response(body), input);
  await adapted.body!.cancel(); expect(canceled).toBe(true);
});

test("ticket bridge transfers no secrets locally, is one-use and releases jobs", async () => {
  let sends = 0;
  const bridge = await startBridge(async (request) => {
    sends++; expect(await request.text()).toBe("SYNTHETIC CONVERSATION");
    return response(envelope(text(3, "ok")), finish(), success());
  }, { env: {} });
  try {
    const local = bridge.rewrite(job());
    expect(new URL(local.url).hostname).toBe("127.0.0.1"); expect(local.headers.get("authorization")).toBeNull(); expect(await local.clone().text()).toBe("{}");
    const adapted = bridge.adapt(local, await fetch(local)); expect(await adapted.text()).toContain('"content":"ok"');
    expect((await fetch(local.url, { method: "POST", body: "{}" })).status).toBe(404);
    expect(sends).toBe(1); expect(bridge.pendingJobs()).toBe(0);
  } finally { await bridge.dispose(); }
});
test("bridge rejects browser origin, wrong method and unknown tickets without dispatch", async () => {
  let sends = 0;
  const bridge = await startBridge(async () => { sends++; return response(); }, { env: {} });
  try {
    const local = bridge.rewrite(job());
    expect((await fetch(local.url, { method: "POST", headers: { Origin: "https://untrusted.invalid" }, body: "{}" })).status).toBe(404);
    expect((await fetch(local.url)).status).toBe(404);
    expect((await fetch(bridge.origin + "/devin/" + "0".repeat(64), { method: "POST" })).status).toBe(404);
    expect(sends).toBe(0);
  } finally { await bridge.dispose(); expect(bridge.pendingJobs()).toBe(0); }
});
test("bridge response hooks propagate a partial protocol error instead of clean EOF", async () => {
  const bridge = await startBridge(async () => response(envelope(text(3, "partial"))), { env: {} });
  try {
    const local = bridge.rewrite(job());
    await expect(bridge.adapt(local, await fetch(local)).text()).rejects.toThrow("validation failed");
  } finally { await bridge.dispose(); }
});
test("queued cancellation and disposal expire tickets before dispatch", async () => {
  let sends = 0;
  const bridge = await startBridge(async () => { sends++; return response(); }, { env: {} });
  const controller = new AbortController(); const local = bridge.rewrite(job(controller.signal)); controller.abort();
  expect(bridge.pendingJobs()).toBe(0); expect((await fetch(local.url, { method: "POST" })).status).toBe(404);
  bridge.rewrite(job()); await bridge.dispose(); expect(bridge.pendingJobs()).toBe(0); expect(sends).toBe(0);
  expect(() => bridge.rewrite(job())).toThrow("closed");
});
test("a connection changed while a ticket was queued stops before any upstream send", async () => {
  let sends = 0;
  const bridge = await startBridge(async () => { sends++; return response(); }, { env: {} });
  try {
    const local = bridge.rewrite({ ...job(), beforeSend: async () => { throw new Error("Synthetic active connection changed"); } });
    const result = await fetch(local); expect(result.status).toBe(502); expect(sends).toBe(0); await result.body?.cancel();
  } finally { await bridge.dispose(); }
});
test("a configured proxy cannot receive the loopback ticket", () => {
  expect(() => assertLoopbackProxy({ HTTPS_PROXY: "http://localhost:7890" })).toThrow("NO_PROXY");
  expect(() => assertLoopbackProxy({ HTTPS_PROXY: "http://localhost:7890", NO_PROXY: "127.0.0.1" })).not.toThrow();
});
