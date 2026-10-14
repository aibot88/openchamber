import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { bytes, double, fields, integer, message, number, string, text, varint } from "../protobuf.ts";
import { envelope, frames } from "../connect.ts";
import { decodeCatalog, createCatalogLoader, models } from "../catalog.ts";
import { encodeChat, subscriptionRequest, type ChatPayload } from "../request.ts";
import { MAX_BYTES, ORIGIN, CATALOG_PATH } from "../constants.ts";

const token = "devin-session-token$synthetic-token-never-valid";
export const entry = { selector: "fixture-model-1", label: "Fixture 1", alias: "fixture", limit: { context: 0, output: 0 } };
export const input: ChatPayload = { model: entry.selector, stream: true, messages: [{ role: "system", content: "ORIGINAL SYSTEM" }, { role: "user", content: "Continue" }],
  tools: [{ type: "function", function: { name: "fixture_confirm", description: "ORIGINAL TOOL DESCRIPTION", parameters: {
    type: "object", properties: { limit: { type: "integer", exclusiveMinimum: 0 }, description: { type: "string", description: "ORIGINAL PROPERTY DESCRIPTION" } }, required: ["limit"], additionalProperties: false,
  } } }] };
export function stream(raw: Uint8Array, width = raw.byteLength) {
  return new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < raw.byteLength; index += width) controller.enqueue(raw.slice(index, index + width)); controller.close(); } });
}
export const catalogRaw = (selector = entry.selector, disabled = 0) => bytes(1, Buffer.concat([text(1, entry.label), integer(4, disabled), text(22, selector), bytes(23, text(23, entry.alias))]));

describe("bounded protobuf and Connect wire", () => {
  test("round-trips integer, UTF-8, fixed64 and unknown fixed32", () => {
    const parsed = fields(Buffer.concat([integer(1, 0xffffffffffffffffn), text(2, "中文🙂"), double(3, 0.95), Buffer.from([0x25, 1, 2, 3, 4])]));
    expect(parsed[0]).toEqual({ tag: 1, wire: 0, value: 0xffffffffffffffffn });
    expect(string(parsed, 2)).toBe("中文🙂");
    expect(parsed[2].wire).toBe(1); expect(parsed[3].wire).toBe(5);
  });
  test.each([Buffer.from([0]), Buffer.from([8, 128]), Buffer.from([11]), Buffer.from([18, 6, 1]), Buffer.from([9, 1]), Buffer.from([8, ...Array(11).fill(255)])])("rejects malformed protobuf", (raw) => { expect(() => fields(raw)).toThrow(); });
  test("rejects negative integer, overflow and nonfinite double", () => {
    expect(() => varint(-1)).toThrow(); expect(() => varint(1n << 64n)).toThrow(); expect(() => double(2, Infinity)).toThrow();
    expect(() => bytes(0, Buffer.alloc(0))).toThrow(); expect(() => number(fields(integer(1, 0xffffffffffffffffn)), 1)).toThrow("safe range");
  });
  test("rejects duplicate singular fields and malformed UTF-8", () => {
    expect(() => string(fields(Buffer.concat([text(1, "a"), text(1, "b")])), 1)).toThrow();
    expect(() => string(fields(bytes(1, Buffer.from([255]))), 1)).toThrow();
  });
  test.each([0, 1])("handles byte-fragmented frames, gzip flag %i", async (flag) => {
    const result: Buffer[] = [];
    for await (const raw of frames(stream(Buffer.concat([envelope(text(3, "中文🙂"), flag), envelope(Buffer.from("{}"), 3)]), 1))) result.push(raw);
    expect(string(fields(result[0]), 3)).toBe("中文🙂"); expect(result.length).toBe(1);
  });
  test.each([Buffer.alloc(0), Buffer.from([0, 0]), envelope(text(3, "partial")), Buffer.concat([envelope(Buffer.from("{}"), 2), envelope(text(3, "late"))]), envelope(Buffer.from("not-json"), 2), envelope(Buffer.from('{"error":{"code":"permission_denied","message":"secret should never appear"}}'), 2)])("rejects incomplete, late or refused Connect stream", async (raw) => {
    await expect((async () => { for await (const _ of frames(stream(raw, 3))) { /* consume */ } })()).rejects.toThrow();
  });
  test("bounds advertised and inflated frame sizes", async () => {
    const huge = Buffer.alloc(5); huge.writeUInt32BE(MAX_BYTES + 1, 1);
    await expect((async () => { for await (const _ of frames(stream(huge))) { } })()).rejects.toThrow("header");
    expect(() => envelope(Buffer.alloc(MAX_BYTES + 1))).toThrow("frame");
    const compressed = gzipSync(Buffer.alloc(MAX_BYTES + 1));
    const header = Buffer.alloc(5); header[0] = 1; header.writeUInt32BE(compressed.length, 1);
    await expect((async () => { for await (const _ of frames(stream(Buffer.concat([header, compressed])))) { } })()).rejects.toThrow();
  });
  test("accepts several bounded frames in one large network chunk", async () => {
    const raw = Buffer.alloc(MAX_BYTES);
    let count = 0;
    for await (const frame of frames(stream(Buffer.concat([envelope(raw), envelope(raw), envelope(Buffer.from("{}"), 2)])))) {
      expect(frame.length).toBe(MAX_BYTES); count++;
    }
    expect(count).toBe(2);
  });
});

describe("live selectors and immutable native history", () => {
  test("catalog routes by selector, never alias, and filters disabled entries", () => {
    expect(decodeCatalog(catalogRaw())).toEqual([entry]);
    expect(decodeCatalog(catalogRaw("disabled", 1))).toEqual([]);
    expect(decodeCatalog(Buffer.alloc(0))).toEqual([]);
  });
  test("rejects malformed, duplicate or path-like selectors", () => {
    expect(() => decodeCatalog(Buffer.concat([catalogRaw(), catalogRaw()]))).toThrow("duplicate");
    expect(() => decodeCatalog(catalogRaw("bad/model"))).toThrow(); expect(() => decodeCatalog(catalogRaw("fixture", 2))).toThrow();
  });
  test("reads per-model context and output from the public Desktop wire tags", () => {
    const raw = bytes(1, Buffer.concat([text(1, entry.label), text(22, entry.selector), integer(18, 1_000_000),
      bytes(23, Buffer.concat([text(23, entry.alias), integer(4, 1_048_576), integer(13, 128_000)]))]));
    const decoded = decodeCatalog(raw);
    expect(decoded[0].limit).toEqual({ context: 1_000_000, output: 128_000 });
    expect(models(decoded)[0].limit).toEqual(decoded[0].limit);
    expect(models(decoded)[0].name).not.toContain("not fully reported");
    // Source metadata is immutable across registry rebuilds.
    expect(models(decoded)[0].limit).not.toBe(decoded[0].limit);
    expect(decoded[0].limit.context).toBe(1_000_000);
  });
  test("uses an available context bound and keeps absent or zero limits unknown", () => {
    for (const extra of [Buffer.alloc(0), integer(18, 0)]) {
      const decoded = decodeCatalog(bytes(1, Buffer.concat([text(22, entry.selector), extra,
        bytes(23, integer(4, 200_000))])));
      expect(decoded[0].limit).toEqual({ context: 200_000, output: 0 });
    }
    expect(models(decodeCatalog(catalogRaw()))[0].limit).toEqual({ context: 0, output: 0 });
    expect(models(decodeCatalog(catalogRaw()))[0].name).toContain("not fully reported");
  });
  test.each([integer(18, 0xffffffff), Buffer.concat([integer(18, 1), integer(18, 2)]), text(18, "wrong-wire")])("refuses invalid catalog token fields", (extra) => {
    expect(() => decodeCatalog(bytes(1, Buffer.concat([text(22, entry.selector), extra])))).toThrow();
  });
  test("one in-flight discovery per identity, separate identities, no failed-as-empty result", async () => {
    let sends = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = createCatalogLoader(async (request) => { sends++; expect(new URL(request.url).pathname).toBe(CATALOG_PATH); await gate; return new Response(new Uint8Array(catalogRaw())); });
    const signal = new AbortController().signal;
    const first = load(token, signal), same = load(token, signal), other = load(token + "2", signal);
    release(); await Promise.all([first, same, other]); expect(sends).toBe(2);
    await load(token, signal); expect(sends).toBe(3);
    await expect(createCatalogLoader(async () => new Response("secret", { status: 401 }))(token, signal)).rejects.toThrow("HTTP 401");
  });
  test("canceling one catalog consumer leaves another consumer's lookup alive", async () => {
    let release!: () => void;
    let upstreamSignal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = createCatalogLoader(async (request) => { upstreamSignal = request.signal; await gate; return new Response(new Uint8Array(catalogRaw())); });
    const first = new AbortController(), second = new AbortController();
    const one = load(token, first.signal), two = load(token, second.signal);
    first.abort(); await expect(one).rejects.toThrow("canceled"); expect(upstreamSignal?.aborted).toBe(false);
    release(); expect(await two).toEqual([entry]);
  });
  test("model limits come from the selected identity even when selectors match", async () => {
    const load = createCatalogLoader(async (request) => {
      const second = request.headers.get("authorization") === `Basic ${token}2-${token}2`;
      return new Response(new Uint8Array(bytes(1, Buffer.concat([text(22, entry.selector), integer(18, second ? 1_000_000 : 200_000),
        bytes(23, integer(13, second ? 128_000 : 8192))]))));
    });
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([load(token, signal), load(token + "2", signal)]);
    expect(models(a)[0].limit).toEqual({ context: 200_000, output: 8192 });
    expect(models(b)[0].limit).toEqual({ context: 1_000_000, output: 128_000 });
    expect(models(await load(token, signal))[0].limit.output).toBe(8192);
  });
  test("canceling the last catalog consumer aborts upstream and allows fresh discovery", async () => {
    let aborted = false;
    const load = createCatalogLoader(async (request) => {
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      throw new Error("synthetic cancellation");
    });
    const controller = new AbortController();
    const result = load(token, controller.signal); controller.abort();
    await expect(result).rejects.toThrow("canceled"); expect(aborted).toBe(true);
  });
  test("encodes complete native tool calls/results, IDs, schemas and reasoning without mutation", () => {
    const history: ChatPayload = { ...input, messages: [...input.messages,
      { role: "assistant", content: "kept text", reasoning_content: "prior reasoning", tool_calls: [{ id: "A-call", type: "function", function: { name: "fixture_confirm", arguments: '{"limit":1,"description":"argument"}' } }] },
      { role: "tool", tool_call_id: "A-call", content: "TOOL-MARKER" }] };
    const before = JSON.stringify(history);
    const raw = fields(encodeChat(history, token, "same-opencode-session"));
    expect(string(raw, 2)).toBe("ORIGINAL SYSTEM"); expect(string(raw, 21)).toBe(entry.selector);
    const definition = raw.find((field) => field.tag === 10); if (definition?.wire !== 2) throw new Error("Missing definition");
    const fn = fields(definition.value);
    expect(string(fn, 2)).toBe(input.tools![0].function.description);
    expect(JSON.parse(string(fn, 3)!)).toEqual(input.tools![0].function.parameters);
    const turns = raw.filter((field) => field.tag === 3 && field.wire === 2).map((field) => { if (field.wire !== 2) throw new Error(); return fields(field.value); });
    expect(string(turns[1], 11)).toBe("prior reasoning"); expect(string(fields(message(turns[1], 6)!), 1)).toBe("A-call");
    expect(number(turns[2], 2)).toBe(4); expect(string(turns[2], 7)).toBe("A-call"); expect(string(turns[2], 3)).toBe("TOOL-MARKER");
    expect(JSON.stringify(history)).toBe(before);
    expect(string(raw, 16)).toBe(string(fields(encodeChat({ ...history, model: "fixture-model-2" }, token, "same-opencode-session")), 16));
    expect(string(raw, 16)).not.toBe(string(fields(encodeChat(history, token + "2", "same-opencode-session")), 16));
  });
  const invalidHistory: ChatPayload[] = [
    { ...input, messages: [{ role: "tool", tool_call_id: "unknown", content: "x" }] },
    { ...input, messages: [...input.messages, { role: "system", content: "late" }] },
    { ...input, messages: [...input.messages, { role: "assistant", tool_calls: [{ id: "missing-result", type: "function", function: { name: "fixture_confirm", arguments: "{}" } }] }] },
  ];
  test.each(invalidHistory)("does not repair invalid native history", (value) => { expect(() => encodeChat(value, token, "session")).toThrow(); });
  test("rewrites only the transport request with the selected account's exact model", async () => {
    const make = (value: unknown) => new Request(`${ORIGIN}/v1/chat/completions`, { method: "POST", body: JSON.stringify(value) });
    const rewritten = await subscriptionRequest(make(input), token, "session", [entry], entry.selector);
    expect(rewritten.request.url).toBe(`${ORIGIN}/exa.api_server_pb.ApiServerService/GetChatMessage`);
    expect(rewritten.request.headers.get("authorization")).toBe(`Basic ${token}-${token}`);
    // GetChatMessage refuses a gzip-compressed request frame with an
    // "internal" trailer error; the request envelope stays uncompressed.
    expect(new Uint8Array(await rewritten.request.arrayBuffer())[0]).toBe(0);
    await expect(subscriptionRequest(make({ ...input, store: false }), token, "session", [entry], entry.selector, "default")).resolves.toBeDefined();
    await expect(subscriptionRequest(make(input), token, "session", [], entry.selector)).rejects.toThrow("absent");
    await expect(subscriptionRequest(make(input), token, "session", [entry], "different-model")).rejects.toThrow("absent");
    await expect(subscriptionRequest(make(input), token, "session", [entry], entry.selector, "high")).rejects.toThrow("separate catalog");
  });
  test("output limits follow the exact selected catalog entry and never occupy the newline field", async () => {
    const known = { ...entry, limit: { context: 1_000_000, output: 128_000 } };
    const other = { ...entry, selector: "other", limit: { context: 200_000, output: 4096 } };
    const convert = (extra: Partial<ChatPayload>, entries = [known, other]) => subscriptionRequest(
      new Request(`${ORIGIN}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ ...input, ...extra }) }),
      token, "session", entries, entry.selector);
    for (const extra of [{}, { max_tokens: 65_536 }, { max_completion_tokens: 128_000 }]) {
      const job = await convert(extra);
      const config = fields(message(fields(encodeChat(job.input, token, "session")), 8)!);
      expect(number(config, 2)).toBe("max_tokens" in extra ? extra.max_tokens : 128_000);
      expect(number(config, 3)).toBeUndefined();
    }
    await expect(convert({ max_tokens: 128_001 })).rejects.toThrow("catalog limit");
    await expect(convert({ max_tokens: 1, max_completion_tokens: 2 })).rejects.toThrow("Conflicting");
    const unknown = await convert({}, [entry]);
    expect(number(fields(message(fields(encodeChat(unknown.input, token, "session")), 8)!), 2)).toBeUndefined();
    expect((await convert({ max_tokens: 65_536 }, [entry])).input.max_tokens).toBe(65_536);
  });
  test.each([{ store: true }, { temperature: 0 }, { tool_choice: "required" }, { response_format: { type: "json_object" } }, { parallel_tool_calls: false }, { reasoning_effort: "high" }, { stream: false }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image" } }] }] }])("refuses unsupported settings or media before inference", async (extra) => {
    const request = new Request(`${ORIGIN}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ ...input, ...extra }) });
    await expect(subscriptionRequest(request, token, "session", [entry], entry.selector)).rejects.toThrow("Unsupported Devin input");
  });
});
