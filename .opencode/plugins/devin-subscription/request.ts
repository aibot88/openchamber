import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CHAT_PATH, ORIGIN, MAX_BYTES } from "./constants.ts";
import { bytes, integer, text, double } from "./protobuf.ts";
import { metadata, envelope, readLimited } from "./connect.ts";
import { identity, type CatalogEntry } from "./catalog.ts";

const name = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const id = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/);
const toolCall = z.strictObject({ id, type: z.literal("function"), function: z.strictObject({ name, arguments: z.string().max(MAX_BYTES) }) });
const content = z.union([z.string(), z.array(z.strictObject({ type: z.literal("text"), text: z.string() }))]).nullable();
const chatMessage = z.strictObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]), content: content.optional(),
  tool_calls: z.array(toolCall).max(128).optional(), tool_call_id: id.optional(),
  reasoning_content: z.string().optional(), reasoning: z.string().optional(),
});
const tool = z.strictObject({ type: z.literal("function"), function: z.strictObject({
  name, description: z.string().optional(), parameters: z.record(z.string(), z.json()).optional(), strict: z.boolean().optional(),
}) });
const payload = z.strictObject({
  model: z.string(), messages: z.array(chatMessage).max(10000), stream: z.literal(true),
  tools: z.array(tool).max(1024).optional(),
  max_tokens: z.number().int().positive().max(0x7fffffff).optional(),
  max_completion_tokens: z.number().int().positive().max(0x7fffffff).optional(),
  temperature: z.number().min(0.001).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  tool_choice: z.literal("auto").optional(), parallel_tool_calls: z.literal(true).optional(),
  stream_options: z.strictObject({ include_usage: z.boolean() }).optional(),
  // The native OpenAI-compatible driver sends this opt-out by default. Devin
  // has no calibrated equivalent; its own retention terms still apply.
  store: z.literal(false).optional(),
});
export type ChatPayload = z.infer<typeof payload>;
const messageText = (value: z.infer<typeof content> | undefined) =>
  value == null ? "" : typeof value === "string" ? value : value.map((part) => part.text).join("");

function validateArguments(raw: string): void {
  try {
    if (z.record(z.string(), z.json()).safeParse(JSON.parse(raw)).success) return;
  } catch { /* Never echo tool arguments in a validation exception. */ }
  throw new Error("Devin native tool arguments must be a complete JSON object. No repair or substitution was attempted.");
}

export function encodeChat(input: ChatPayload, token: string, sessionID: string): Buffer {
  const system: string[] = [];
  const messages: Buffer[] = [];
  const calls = new Set<string>();
  const resolved = new Set<string>();
  for (const item of input.messages) {
    const body = messageText(item.content);
    if (item.role === "system" || item.role === "developer") {
      if (messages.length || item.tool_calls || item.tool_call_id || item.reasoning || item.reasoning_content) throw new Error("Devin requires leading text-only system instructions. History was not reordered.");
      system.push(body); continue;
    }
    if (item.role !== "assistant" && (item.tool_calls || item.reasoning || item.reasoning_content)) throw new Error("Invalid native tool or reasoning history role.");
    if (item.role !== "tool" && item.tool_call_id) throw new Error("Invalid tool-result history role.");
    const parts = [text(1, randomUUID()), integer(2, item.role === "assistant" ? 2 : item.role === "tool" ? 4 : 1), text(3, body)];
    const reasoning = item.reasoning_content ?? item.reasoning;
    if (reasoning !== undefined) parts.push(text(11, reasoning));
    if (item.role === "tool") {
      if (!item.tool_call_id || !calls.has(item.tool_call_id) || resolved.has(item.tool_call_id)) throw new Error("Missing, unknown or repeated native tool-result ID.");
      resolved.add(item.tool_call_id); parts.push(text(7, item.tool_call_id));
    }
    for (const call of item.tool_calls ?? []) {
      if (calls.has(call.id)) throw new Error("Repeated native tool-call ID in history.");
      calls.add(call.id); validateArguments(call.function.arguments);
      parts.push(bytes(6, Buffer.concat([text(1, call.id), text(2, call.function.name), text(3, call.function.arguments)])));
    }
    messages.push(Buffer.concat(parts));
  }
  if ([...calls].some((call) => !resolved.has(call))) throw new Error("Unresolved native tool call in the outgoing history.");
  const names = new Set<string>();
  const definitions = (input.tools ?? []).map((definition) => {
    const fn = definition.function;
    if (names.has(fn.name)) throw new Error("Duplicate native tool declaration.");
    if (fn.strict) throw new Error("Devin strict tool-schema enforcement is not calibrated. No strict flag was silently dropped.");
    names.add(fn.name);
    // Preserve the JSON Schema and descriptions verbatim. In particular, do
    // not copy WindsurfAPI's MCP-gate neutralization or prompt emulation.
    return bytes(10, Buffer.concat([text(1, fn.name), ...(fn.description === undefined ? [] : [text(2, fn.description)]),
      ...(fn.parameters === undefined ? [] : [text(3, JSON.stringify(fn.parameters))])]));
  });
  const stable = createHash("sha256").update(sessionID).update(identity(token)).digest("hex").slice(0, 32);
  const session = `${stable.slice(0, 8)}-${stable.slice(8, 12)}-${stable.slice(12, 16)}-${stable.slice(16, 20)}-${stable.slice(20)}`;
  const output = input.max_completion_tokens ?? input.max_tokens;
  const raw = Buffer.concat([bytes(1, metadata(token)), text(2, system.join("\n")), ...messages.map((item) => bytes(3, item)),
    integer(7, 5), bytes(8, Buffer.concat([integer(1, 1), ...(output === undefined ? [] : [integer(2, output)]),
      // Field 3 is max_newlines. It is unrelated to the context window.
      double(5, input.temperature ?? 1), integer(7, 40), double(8, input.top_p ?? 0.95)])),
    bytes(15, Buffer.concat([text(1, randomUUID()), integer(2, 1), integer(3, 4)])), text(16, session),
    integer(20, 1), text(21, input.model), ...definitions]);
  if (raw.length > MAX_BYTES) throw new Error("Devin request exceeds the size limit.");
  return raw;
}

export async function subscriptionRequest(request: Request, token: string, sessionID: string, entries: readonly CatalogEntry[], selectedModel: string, variant?: string) {
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.pathname !== "/v1/chat/completions" || url.search || request.method !== "POST") throw new Error("Unsupported Devin native driver request.");
  if (variant && variant !== "default") throw new Error("Devin tiers are separate catalog models. Select the exact model, not an inferred variant.");
  request.signal.throwIfAborted();
  const raw = await readLimited(new Response(request.body));
  let input: ChatPayload;
  try { input = payload.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))); }
  catch { throw new Error("Unsupported Devin input. This release accepts text, native function tools and streaming chat only; unsupported settings or private reasoning carriers are not silently dropped."); }
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined && input.max_tokens !== input.max_completion_tokens) throw new Error("Conflicting Devin output token limits.");
  const entry = entries.find((entry) => entry.selector === input.model);
  if (input.model !== selectedModel || !entry) throw new Error("The selected Devin model is absent from the active connection's catalog. No alias or model fallback was attempted.");
  const output = input.max_completion_tokens ?? input.max_tokens;
  if (entry.limit.output > 0) {
    if (output !== undefined && output > entry.limit.output) throw new Error("Requested output exceeds the selected Devin model's catalog limit. No truncation or model fallback was attempted.");
    if (output === undefined) input = { ...input, max_tokens: entry.limit.output };
  }
  // GetChatMessage rejects a gzip-compressed request frame with a generic
  // "internal" trailer error (live-verified 2026-10-14, swe-2/high). The
  // pinned reference sends the request uncompressed; only responses arrive
  // gzipped. Do not reintroduce request compression here.
  const body = envelope(encodeChat(input, token, sessionID), 0);
  request.signal.throwIfAborted();
  return { input, request: new Request(ORIGIN + CHAT_PATH, { method: "POST", body: new Uint8Array(body), signal: request.signal, redirect: "error",
    headers: { Authorization: `Basic ${token}-${token}`, "Content-Type": "application/connect+proto" } }) };
}
