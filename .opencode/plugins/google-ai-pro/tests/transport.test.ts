import { describe, expect, test } from "bun:test";
import type { Credential } from "@opencode/plugin";
import { BASE_URL, SUBSCRIPTION_ENDPOINT, METHOD_ID, USER_AGENT } from "../constants.ts";
import { subscriptionRequest as convertRequest, subscriptionResponse } from "../transport.ts";
import { catalogFromPayload } from "../catalog.ts";
import { subscriptionModels } from "../models.ts";
import { assertSubscriptionSchema } from "../fixtures/schema-validator.ts";

const credential: Credential.OAuth = {
  type: "oauth", methodID: METHOD_ID, access: "test-access", refresh: "test-refresh",
  expires: Date.now() + 3600_000, metadata: { projectId: "test-project" },
};
const history = {
  systemInstruction: { parts: [{ text: "Keep the user's instructions." }] },
  contents: [
    { role: "user", parts: [{ text: "Remember marker MEMORY-7391." }] },
    { role: "model", parts: [{ text: "Recorded by model A." }] },
    { role: "model", parts: [{ functionCall: { id: "call_a", name: "read", args: { path: "sample.txt" } }, thoughtSignature: "original-signature" }] },
    { role: "user", parts: [{ functionResponse: { id: "call_a", name: "read", response: { content: "tool result from A" } } }] },
    { role: "user", parts: [{ text: "Model B, continue without repeating the read." }] },
  ],
  tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } } } }] }],
  generationConfig: { thinkingConfig: { thinkingBudget: 10001, includeThoughts: true } },
};
const catalog = catalogFromPayload({ models: Object.fromEntries([
  "gemini-pro-agent", "gemini-3.1-pro-low", "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium", "gemini-3.8-flash-high",
].map((id) => [id, {}])) });
const subscriptionRequest = (input: Request, value: Credential.Value | undefined, sessionID: string) => convertRequest(input, value, sessionID, catalog);

function request(body = history, action = "streamGenerateContent") {
  return new Request(`${BASE_URL}/models/gemini-3.1-pro:${action}?alt=sse`, {
    method: "POST", headers: { "x-goog-api-key": "must-be-removed", "x-goog-user-project": "wrong-project" },
    body: JSON.stringify(body),
  });
}

describe("subscription transport", () => {
  test("preserves A's full history, tool IDs, results, system and signatures for B", async () => {
    const input = request();
    const before = await input.clone().text();
    const converted = await subscriptionRequest(input, credential, "same-session:primary");
    const body = await converted.json();
    expect(body.request).toEqual({ ...history, sessionId: "same-session:primary" });
    expect(await input.clone().text()).toBe(before);
    expect(body.model).toBe("gemini-pro-agent");
    expect(body.project).toBe("test-project");
    expect(converted.url).toBe(`${SUBSCRIPTION_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`);
    expect(converted.headers.get("x-goog-api-key")).toBeNull();
    expect(converted.headers.get("x-goog-user-project")).toBeNull();
    expect(converted.headers.get("user-agent")).toBe(USER_AGENT);
    expect(converted.redirect).toBe("error");
  });

  test("does not let auxiliary requests reuse the primary backend identity", async () => {
    const primary = await (await subscriptionRequest(request(), credential, "ses:primary")).json();
    const title = await (await subscriptionRequest(request(), credential, "ses:title")).json();
    expect(primary.request.sessionId).not.toBe(title.request.sessionId);
  });

  test("routes Flash's native backend ID without changing history, tools, account or endpoint", async () => {
    const flash = subscriptionModels.find((model) => model.id === "gemini-3.8-flash");
    expect(flash).toBeDefined();
    if (!flash) throw new Error("Flash is missing from the subscription catalog.");
    for (const action of ["generateContent", "streamGenerateContent"]) {
      for (const level of ["low", "medium", "high"]) {
        const budget = level === "low" ? 1000 : level === "high" ? -1 : 4000;
        const contents = { ...history, generationConfig: { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } } };
        const input = new Request(`${BASE_URL}/models/${flash.modelID}:${action}`, {
          method: "POST", body: JSON.stringify(contents),
        });
        const converted = await subscriptionRequest(input, credential, "same-session:primary");
        const body = await converted.json();
        expect(body.model).toBe(`gemini-3.8-flash-${level}`);
        expect(body.project).toBe("test-project");
        expect(body.request).toEqual({ ...contents, sessionId: "same-session:primary" });
        expect(converted.headers.get("authorization")).toBe("Bearer test-access");
        expect(converted.redirect).toBe("error");
        expect(converted.url).toBe(`${SUBSCRIPTION_ENDPOINT}/v1internal:${action}${action === "streamGenerateContent" ? "?alt=sse" : ""}`);
      }
    }
  });

  test("refuses missing auth, API keys, wrong method and missing project", async () => {
    for (const value of [undefined, { type: "key", key: "paid-api-key" } as const, { ...credential, methodID: "other" as typeof METHOD_ID }, { ...credential, metadata: {} }]) {
      await expect(subscriptionRequest(request(), value, "ses")).rejects.toThrow();
    }
  });

  test("refuses paid API destinations, malformed paths, unsupported models and methods", async () => {
    for (const url of [
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:streamGenerateContent",
      `${BASE_URL}/models/claude-opus:streamGenerateContent`,
      `${BASE_URL}/models/gemini-unknown:streamGenerateContent`,
      `${BASE_URL}/models/gemini-3.1-pro:countTokens`,
    ]) {
      await expect(subscriptionRequest(new Request(url, { method: "POST", body: JSON.stringify(history) }), credential, "ses")).rejects.toThrow("No API fallback");
    }
    await expect(subscriptionRequest(new Request(`${BASE_URL}/models/gemini-3.1-pro:generateContent`), credential, "ses")).rejects.toThrow();
  });

  test("never substitutes a different model or tier when the selected variant is absent", async () => {
    const limited = catalogFromPayload({ models: { "gemini-3.1-pro-low": {}, "gemini-3.8-flash-low": {} } });
    await expect(convertRequest(request(), credential, "ses", limited, "high")).rejects.toThrow("no fallback");
    await expect(convertRequest(new Request(`${BASE_URL}/models/gemini-3.8-flash:generateContent`, {
      method: "POST", body: JSON.stringify({ contents: [] }),
    }), credential, "ses", limited)).rejects.toThrow("gemini-3.8-flash/medium");
  });

  test("cleans only schemas, not property names, tool arguments, results or signatures", async () => {
    const body = {
      ...history,
      tools: [{ functionDeclarations: [{ name: "read", parametersJsonSchema: {
        type: "object", title: "Dropped metadata", additionalProperties: false,
        properties: { title: { type: "string" }, const: { type: "string", const: "fixed" } }, required: ["title", "const"],
      } }] }],
      contents: [{ role: "model", parts: [{ functionCall: { id: "call_x", name: "read", args: { title: "data", const: "data", default: "data" } }, thoughtSignature: "sig" }] },
        { role: "user", parts: [{ functionResponse: { id: "call_x", name: "read", response: { title: "result", const: 9 } } }] }],
    };
    const wire = await (await subscriptionRequest(new Request(`${BASE_URL}/models/gemini-3.1-pro:generateContent`, {
      method: "POST", body: JSON.stringify(body),
    }), credential, "ses")).json();
    expect(wire.request.contents).toEqual(body.contents);
    expect(wire.request.tools).toEqual([{ functionDeclarations: [{ name: "read", parameters: {
      type: "OBJECT", description: "No extra properties allowed.",
      properties: { title: { type: "STRING" }, const: { type: "STRING", description: 'const: "fixed"' } }, required: ["title", "const"],
    } }] }]);
  });

  test("sends a protobuf-safe schema for positive limits in both inference actions", async () => {
    const schema = { type: "object", properties: {
      limit: { type: "integer", exclusiveMinimum: 0, maximum: 100 },
      timeout: { type: "number", exclusiveMinimum: 0, maximum: 120 },
      questions: { type: "array", minItems: 1, items: { type: "object", properties: {
        text: { type: "string", minLength: 1, format: "uri", pattern: "^https://" },
      } } },
    }, required: ["limit"] };
    for (const action of ["generateContent", "streamGenerateContent"]) {
      const body = { ...history, tools: [{ functionDeclarations: [{ name: "bounded_tool", parameters: schema, response: schema }] }],
        generationConfig: { ...history.generationConfig, responseJsonSchema: schema } };
      const input = new Request(`${BASE_URL}/models/gemini-3.1-pro:${action}`, { method: "POST", body: JSON.stringify(body) });
      const original = await input.clone().text();
      const wire = await (await subscriptionRequest(input, credential, "same-session:primary")).json();
      const declaration = wire.request.tools[0].functionDeclarations[0];
      assertSubscriptionSchema(declaration.parameters);
      assertSubscriptionSchema(declaration.response, true);
      assertSubscriptionSchema(wire.request.generationConfig.responseSchema, true);
      expect(declaration.parameters.properties.limit.description).toContain("exclusiveMinimum: 0");
      expect(wire.request.contents).toEqual(history.contents);
      expect(await input.clone().text()).toBe(original);
    }
  });

  test("propagates cancellation", async () => {
    const controller = new AbortController();
    const input = new Request(request(), { signal: controller.signal });
    const converted = await subscriptionRequest(input, credential, "ses");
    controller.abort();
    expect(converted.signal.aborted).toBe(true);
  });

  test("unwraps nonstreaming responses without changing tool calls or usage", async () => {
    const payload = { candidates: [{ content: { parts: [{ functionCall: { name: "read", args: { path: "next.txt" } }, thoughtSignature: "new-signature" }] } }], usageMetadata: { promptTokenCount: 123 } };
    const response = await subscriptionResponse(Response.json({ response: payload }), false);
    expect(await response.json()).toEqual(payload);
  });

  test("preserves auth, suspension and quota errors without fallback", async () => {
    for (const status of [401, 403, 429, 503]) {
      const response = Response.json({ error: { message: "test error", code: status } }, { status });
      expect(await subscriptionResponse(response, true)).toBe(response);
    }
  });

  test("streams split UTF-8, CRLF, comments and tool/signature events", async () => {
    const payload = { candidates: [{ content: { parts: [{ text: "记忆" }, { functionCall: { name: "read", args: { path: "next.txt" } }, thoughtSignature: "sig" }] } }] };
    const bytes = new TextEncoder().encode(`: ping\r\n\r\nid: 7\r\ndata: ${JSON.stringify({ response: payload })}\r\n\r\ndata: [DONE]\r\n\r\n`);
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const response = await subscriptionResponse(new Response(source, { headers: { "content-length": "9999", "content-encoding": "gzip" } }), true);
    const text = await response.text();
    expect(text).toContain(`id: 7\ndata: ${JSON.stringify(payload)}\n\n`);
    expect(text).toContain(": ping\n\n");
    expect(text).toContain("data: [DONE]\n\n");
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.has("content-encoding")).toBe(false);
  });

  test("emits a complete event before the upstream finishes", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start(controller) { push = controller; } });
    const response = await subscriptionResponse(new Response(source), true);
    const reader = response.body!.getReader();
    push.enqueue(new TextEncoder().encode('data: {"response":{"value":1}}\n\n'));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: {"value":1}\n\n');
    push.close();
    await reader.read();
  });

  test("rejects malformed stream events instead of returning empty success", async () => {
    const response = await subscriptionResponse(new Response("data: invalid-json\n\n"), true);
    await expect(response.text()).rejects.toThrow();
  });
});
