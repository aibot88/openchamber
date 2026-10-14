import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fields, message, number, string } from "./protobuf.ts";
import { frames } from "./connect.ts";
import type { ChatPayload } from "./request.ts";

interface Call { id: string; name: string; arguments: string; invalidJson?: boolean }
export async function subscriptionResponse(response: Response, input: ChatPayload): Promise<Response> {
  if (!response.ok) {
    await response.body?.cancel();
    return Response.json({ error: { message: `Devin rejected the request (HTTP ${response.status}). No retry or fallback was attempted.`, type: "devin_subscription_error" } }, { status: response.status });
  }
  if (!response.body) throw new Error("Missing Devin stream body.");
  const cancellation = new AbortController();
  const iterator = frames(response.body, cancellation.signal)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`;
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: input.model };
  const calls = new Map<string, Call>();
  let open: Call | undefined;
  let stop: number | undefined;
  let size = 0;
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details: { cached_tokens: number }; cache_creation_input_tokens: number } | undefined;
  const chunk = (delta: { content?: string; reasoning_content?: string; tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string } }[] }, finish: string | null = null) =>
    encoder.encode(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const generator = (async function* () {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const frame = fields(next.value);
      const content = string(frame, 3), reasoning = string(frame, 9);
      size += Buffer.byteLength(content ?? "") + Buffer.byteLength(reasoning ?? "");
      if (size > 32 * 1024 * 1024) throw new Error("Devin answer exceeds the size limit.");
      if (content) yield chunk({ content });
      if (reasoning) yield chunk({ reasoning_content: reasoning });
      for (const field of frame) {
        if (field.tag !== 6) continue;
        if (field.wire !== 2) throw new Error("Invalid native tool frame.");
        const parts = fields(field.value);
        // ChatToolCall fields 4/5 (invalid_json_str/invalid_json_err) report
        // arguments the model emitted that were not valid JSON. Upstream's own
        // control loop substitutes an empty object for them; mirror that instead
        // of failing the whole turn. Field 6 is is_custom_tool_call; ignored.
        const reportedInvalid = string(parts, 4) !== undefined || string(parts, 5) !== undefined;
        const callID = string(parts, 1), callName = string(parts, 2), args = string(parts, 3) ?? "";
        if (callID && !calls.has(callID)) {
          if (calls.size >= 128) throw new Error("Too many native Devin tool calls.");
          open = { id: callID, name: callName ?? "", arguments: "" }; calls.set(callID, open);
        } else if (callID) open = calls.get(callID);
        if (!open) throw new Error("Devin sent a tool fragment without an initial call ID.");
        if (reportedInvalid) open.invalidJson = true;
        if (callName) {
          if (open.name && open.name !== callName) throw new Error("Devin changed the name of a native tool call.");
          open.name = callName;
        }
        open.arguments += args; size += Buffer.byteLength(args);
        if (size > 32 * 1024 * 1024 || open.arguments.length > 8 * 1024 * 1024) throw new Error("Devin tool arguments exceed the size limit.");
      }
      const finish = number(frame, 5);
      if (finish !== undefined) {
        // The upstream stop enum is only partially calibrated: 2 was the
        // free-tier stop and 3/4 are observed clean completions on paid
        // accounts. Rejecting unverified values turned every normal paid
        // answer into a stream failure, so any varint finish marks completion.
        // A real refusal still fails earlier as a trailer error, and output
        // truncation is reported through finish_reason below.
        stop = finish;
      }
      const meta = message(frame, 7);
      if (meta) {
        const stats = fields(meta);
        const prompt = number(stats, 2), completion = number(stats, 3);
        const write = number(stats, 4) ?? 0, cached = number(stats, 5) ?? 0;
        if (prompt !== undefined && completion !== undefined) {
          const total = prompt + completion + write + cached;
          if (!Number.isSafeInteger(total)) throw new Error("Invalid Devin token usage.");
          usage = { prompt_tokens: prompt + write + cached, completion_tokens: completion,
            total_tokens: total, prompt_tokens_details: { cached_tokens: cached }, cache_creation_input_tokens: write };
        }
      }
    }
    // Wait for a successful trailer AND EOF before exposing any tool call to
    // OpenCode. A late entitlement/policy refusal must never execute a tool.
    if (stop === undefined) throw new Error("Devin returned an incomplete completion. No retry was attempted.");
    const allowed = new Set((input.tools ?? []).map((tool) => tool.function.name));
    for (const call of calls.values()) {
      let valid = false;
      try { valid = z.record(z.string(), z.json()).safeParse(JSON.parse(call.arguments)).success; } catch { /* Invalid JSON is evaluated below. */ }
      if (call.invalidJson && !valid) call.arguments = "{}";
      if (!call.id || !allowed.has(call.name) || (!valid && !call.invalidJson)) throw new Error("Devin returned an undeclared tool, missing call identity or invalid JSON arguments. No guessing or repair was attempted.");
    }
    let index = 0;
    for (const call of calls.values()) yield chunk({ tool_calls: [{ index: index++, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] });
    const outputCap = input.max_completion_tokens ?? input.max_tokens;
    const truncated = !calls.size && outputCap !== undefined && usage !== undefined && usage.completion_tokens >= outputCap;
    yield chunk({}, calls.size ? "tool_calls" : truncated ? "length" : "stop");
    if (usage) yield encoder.encode(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
    yield encoder.encode("data: [DONE]\n\n");
  })();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await generator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      } catch {
        cancellation.abort();
        await iterator.return?.(undefined).catch(() => {});
        controller.error(new Error("Devin stream decoding, completion status or native tool validation failed. No retry or fallback was attempted."));
      }
    },
    async cancel() { cancellation.abort(); await iterator.return?.(undefined).catch(() => {}); await generator.return(undefined).catch(() => {}); },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
