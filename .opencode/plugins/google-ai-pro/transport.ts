import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Credential } from "@opencode/plugin";
import { BASE_URL, SUBSCRIPTION_ENDPOINT, USER_AGENT } from "./constants.ts";
import { credentialProject, type Catalog } from "./catalog.ts";
import { budgets } from "./models.ts";
import { normalizeGeminiSchemas } from "./gemini-schema.ts";

// Gemini's contents, tool pairs, signatures and system instructions are opaque
// here. OpenCode's native Gemini protocol already converts the shared history.
const bodySchema = z.object({ contents: z.array(z.unknown()) }).passthrough();
const envelopeSchema = z.object({ response: z.record(z.string(), z.unknown()) }).passthrough();

export function projectId(credential: Credential.OAuth): string {
  return credentialProject(credential);
}

export async function subscriptionRequest(
  original: Request,
  credential: Credential.Value | undefined,
  sessionID: string,
  catalog: Catalog,
  variant?: string,
): Promise<Request> {
  const project = credentialProject(credential);
  if (credential?.type !== "oauth") throw new Error("Subscription OAuth is required.");
  const url = new URL(original.url);
  const base = new URL(BASE_URL);
  const match = url.pathname.match(/^\/v1beta\/models\/(gemini-[\w.-]+):(streamGenerateContent|generateContent)$/);
  if (url.origin !== base.origin || original.method !== "POST" || !match) {
    throw new Error("Unsupported Google subscription request. No API fallback is permitted.");
  }
  const [, model, action] = match;
  const parsed = bodySchema.safeParse(await original.clone().json());
  if (!parsed.success) throw new Error("Invalid native Gemini request.");
  const publicID = model === "gemini-3.8-flash-tiered" ? "gemini-3.8-flash" : model;
  if (publicID !== "gemini-3.1-pro" && publicID !== "gemini-3.8-flash") {
    throw new Error("Unsupported subscription model. No API fallback is permitted.");
  }
  const payload = normalizeGeminiSchemas(parsed.data);
  const generationConfig = { ...(payload.generationConfig as Record<string, unknown> | undefined) };
  const thinkingConfig = { ...(generationConfig.thinkingConfig as Record<string, unknown> | undefined) };
  const budget = thinkingConfig.thinkingBudget;
  const defaultLevel = publicID === "gemini-3.1-pro" ? "low" : "medium";
  const level = variant && variant !== "default" ? variant :
    typeof thinkingConfig.thinkingLevel === "string" ? thinkingConfig.thinkingLevel :
    Object.entries(budgets[publicID]).find(([, value]) => value === budget)?.[0] ?? defaultLevel;
  const wireID = catalog.routes.get(publicID)?.get(level);
  if (!wireID) throw new Error(`Google's subscription catalog does not offer the selected model/variant (${publicID}/${level}). Switch manually; no fallback was attempted.`);
  const wireBudget = (budgets[publicID] as Record<string, number>)[level];
  delete thinkingConfig.thinkingLevel;
  thinkingConfig.thinkingBudget = wireBudget;
  thinkingConfig.includeThoughts = true;
  generationConfig.thinkingConfig = thinkingConfig;
  const headers = new Headers({
    Authorization: `Bearer ${credential.access}`,
    "Content-Type": "application/json",
    Accept: action === "streamGenerateContent" ? "text/event-stream" : "application/json",
    "User-Agent": USER_AGENT,
  });
  return new Request(`${SUBSCRIPTION_ENDPOINT}/v1internal:${action}${action === "streamGenerateContent" ? "?alt=sse" : ""}`, {
    method: "POST",
    headers,
    signal: original.signal,
    redirect: "error",
    body: JSON.stringify({
      project,
      model: wireID,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: `agent-${randomUUID()}`,
      request: { ...payload, generationConfig, sessionId: sessionID },
    }),
  });
}

export function unwrapPayload(payload: unknown): unknown {
  const envelope = envelopeSchema.safeParse(payload);
  return envelope.success ? envelope.data.response : payload;
}

function unwrapEvent(event: string): string {
  const lines = event.split("\n");
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
  if (data.length === 0 || data.join("\n").trim() === "[DONE]") return `${event}\n\n`;
  const payload = JSON.parse(data.join("\n"));
  const other = lines.filter((line) => !line.startsWith("data:"));
  return [...other, `data: ${JSON.stringify(unwrapPayload(payload))}`, "", ""].join("\n");
}

export async function subscriptionResponse(response: Response, streaming: boolean): Promise<Response> {
  // Preserve authentication, quota and access errors. No account/model rotation.
  if (!response.ok || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (!streaming) {
    return new Response(JSON.stringify(unwrapPayload(await response.json())), {
      status: response.status,
      headers,
    });
  }
  let pending = "";
  const stream = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
    transform(chunk, controller) {
      pending += chunk;
      // Normalize complete CRLF pairs, keeping a trailing CR until the next chunk.
      pending = pending.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        if (boundary > 8 * 1024 * 1024) throw new Error("Subscription stream event exceeded 8 MiB.");
        controller.enqueue(unwrapEvent(pending.slice(0, boundary)));
        pending = pending.slice(boundary + 2);
      }
      if (pending.length > 8 * 1024 * 1024) throw new Error("Subscription stream event exceeded 8 MiB.");
    },
    flush(controller) {
      if (pending.trim()) controller.enqueue(unwrapEvent(pending));
    },
  })).pipeThrough(new TextEncoderStream());
  headers.set("Content-Type", "text/event-stream");
  return new Response(stream, { status: response.status, headers });
}
