import { expect, test } from "bun:test";
import { integer, text } from "../protobuf.ts";
import { envelope, frames } from "../connect.ts";
import { subscriptionResponse } from "../response.ts";
import { startBridge } from "../bridge.ts";
import { busyCode, busyMessage, busyRetry, busyStatus, isBusy } from "../capacity.ts";
import { ORIGIN, CHAT_PATH } from "../constants.ts";
import type { ChatPayload } from "../request.ts";

const input: ChatPayload = { model: "fixture-model-1", stream: true, messages: [{ role: "user", content: "Continue" }] };
const job = () => ({ input, request: new Request(ORIGIN + CHAT_PATH, { method: "POST", headers: { Authorization: "Basic synthetic-only" }, body: "SYNTHETIC CONVERSATION" }) });
const trailer = (code: string) => envelope(Buffer.from(JSON.stringify({ error: { code, message: "PRIVATE-SERVER-DATA" } })), 2);
const wire = (...parts: Uint8Array[]) => new Response(new Uint8Array(Buffer.concat(parts)), { headers: { "Content-Type": "application/connect+proto" } });
const finish = () => envelope(integer(5, 2));
const stream = (raw: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < raw.byteLength; index += 3) controller.enqueue(raw.slice(index, index + 3)); controller.close(); } });

test("only the saturated-model codes and statuses classify as capacity", () => {
  for (const code of ["unavailable", "resource_exhausted"]) expect(busyCode(code)).toBe(true);
  for (const code of [undefined, "permission_denied", "invalid_argument", "unknown", "unavailable "]) expect(busyCode(code)).toBe(false);
  for (const status of [429, 503]) expect(busyStatus(status)).toBe(true);
  for (const status of [500, 502, 504, 400, 403]) expect(busyStatus(status)).toBe(false);
});

test("the busy marker never echoes an upstream message", () => {
  const message = busyMessage("unavailable");
  expect(isBusy(message)).toBe(true); expect(message).toContain("unavailable"); expect(message).not.toContain("PRIVATE-SERVER-DATA");
  expect(isBusy("Devin stream decoding failed.")).toBe(false);
});

test("capacity retries escalate on a bounded schedule then stop", () => {
  expect(busyRetry(0)).toEqual({ retry: true, delay: 15_000 });
  expect(busyRetry(1)).toEqual({ retry: true, delay: 15_000 });
  expect(busyRetry(4)).toEqual({ retry: true, delay: 120_000 });
  expect(busyRetry(5)).toEqual({ retry: false });
  expect(busyRetry(99)).toEqual({ retry: false });
});

test("a busy trailer code surfaces its authored reason; other codes stay generic", async () => {
  const read = async (raw: Uint8Array) => { for await (const _ of frames(stream(raw))) { /* consume */ } };
  await expect(read(trailer("unavailable"))).rejects.toThrow("capacity is busy");
  await expect(read(trailer("resource_exhausted"))).rejects.toThrow("capacity is busy");
  await expect(read(trailer("permission_denied"))).rejects.toThrow("rejected the request (permission_denied)");
});

test.each([
  [{ status: 503, body: { code: "unavailable", message: "PRIVATE-SERVER-DATA" } }, "capacity is busy"],
  [{ status: 503, body: "not-json" }, "capacity is busy"],
  [{ status: 429, body: "" }, "capacity is busy"],
  [{ status: 500, body: "PRIVATE-SERVER-DATA" }, "rejected the request (HTTP 500)"],
  [{ status: 403, body: { code: "permission_denied", message: "PRIVATE-SERVER-DATA" } }, "rejected the request (permission_denied)"],
] as const)("HTTP refusal maps the Connect code or status without echoing upstream text", async (refusal, expected) => {
  const body = typeof refusal.body === "string" ? refusal.body : JSON.stringify(refusal.body);
  const result = await subscriptionResponse(new Response(body, { status: refusal.status }), input);
  const message = (await result.json()).error.message;
  expect(result.status).toBe(refusal.status); expect(message).toContain(expected); expect(message).not.toContain("PRIVATE-SERVER-DATA");
  expect(isBusy(message)).toBe(expected === "capacity is busy");
});

test("a mid-stream capacity refusal keeps its reason across the bridge instead of the generic stream error", async () => {
  const bridge = await startBridge(async () => wire(envelope(text(3, "partial")), trailer("unavailable")), { env: {} });
  try {
    const local = bridge.rewrite(job());
    await expect(bridge.adapt(local, await fetch(local)).text()).rejects.toThrow("capacity is busy");
  } finally { await bridge.dispose(); }
});

test("a mid-stream policy refusal surfaces its code across the bridge; a transport failure stays generic", async () => {
  const refused = await startBridge(async () => wire(envelope(text(3, "partial")), trailer("permission_denied")), { env: {} });
  try {
    const local = refused.rewrite(job());
    await expect(refused.adapt(local, await fetch(local)).text()).rejects.toThrow("rejected the request (permission_denied)");
  } finally { await refused.dispose(); }
  const dropped = await startBridge(async () => wire(envelope(text(3, "partial")), finish()), { env: {} });
  try {
    const local = dropped.rewrite(job());
    await expect(dropped.adapt(local, await fetch(local)).text()).rejects.toThrow("validation failed");
  } finally { await dropped.dispose(); }
});
