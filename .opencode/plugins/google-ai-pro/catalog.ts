// Account-bound discovery follows CLIProxyAPI's fetchAvailableModels contract.
// Same-family variant aliases/budgets follow CortexKit's live-catalog resolver.
import { createHash } from "node:crypto";
import { Model, type Credential } from "@opencode/plugin";
import { z } from "zod";
import { METHOD_ID, SUBSCRIPTION_ENDPOINT, USER_AGENT } from "./constants.ts";
import { jsonResponse, type Fetch } from "./google-http.ts";
import { subscriptionModels } from "./models.ts";

const schema = z.object({ models: z.record(z.string(), z.unknown()) });
export type Catalog = {
  models: readonly Model.Info[];
  routes: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

export function catalogFromPayload(payload: unknown): Catalog {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error("Subscription model discovery returned an invalid catalog.");
  const ids = new Set(Object.keys(parsed.data.models).map((id) => id.trim().toLowerCase()));
  const routes = new Map<string, Map<string, string>>();
  const models: Model.Info[] = [];
  for (const model of subscriptionModels) {
    const variants = new Map<string, string>();
    for (const variant of model.variants) {
      const candidates = model.id === "gemini-3.1-pro"
        ? variant.id === "high" ? ["gemini-pro-agent", "gemini-3.1-pro-high", "gemini-3.1-pro"] :
          ["gemini-3.1-pro-low", "gemini-3.1-pro"]
        : [`${model.id}-${variant.id}`, `${model.id}-tiered`, String(model.id)];
      const wireID = candidates.find((id) => ids.has(id));
      if (wireID) variants.set(variant.id, wireID);
    }
    routes.set(model.id, variants);
    const defaultLevel = model.id === "gemini-3.1-pro" ? "low" : "medium";
    // Keep the user's default, even if it is unavailable. Never silently use a
    // different thinking tier. Individual available variants remain selectable.
    models.push({ ...model, enabled: variants.size > 0,
      variants: model.variants.filter((variant) => variants.has(variant.id)),
      modelID: Model.ID.make(String(model.id)),
      name: variants.has(defaultLevel) ? model.name : `${model.name} · default unavailable`,
    });
  }
  return { models, routes };
}

export function credentialProject(credential: Credential.Value | undefined): string {
  if (credential?.type !== "oauth" || credential.methodID !== METHOD_ID || !credential.access) {
    throw new Error("Connect Google AI Pro (unofficial) in provider settings before using this model.");
  }
  const project = credential.metadata?.projectId;
  if (typeof project !== "string" || !project.trim()) throw new Error("Sign in to Google AI Pro again; the connection has no project.");
  return project;
}

export function catalogKey(credential: Credential.OAuth): string {
  // Kept only in memory. No refresh token, account email or project is logged.
  return createHash("sha256").update(JSON.stringify([credential.refresh || credential.access, credentialProject(credential), SUBSCRIPTION_ENDPOINT])).digest("hex");
}

export function createCatalogLoader(fetcher: Fetch, options: { now?: () => number; signal?: AbortSignal } = {}) {
  const entries = new Map<string, { catalog?: Catalog; error?: Error; until: number; pending?: Promise<Catalog> }>();
  const now = options.now ?? Date.now;
  return async (credential: Credential.OAuth): Promise<Catalog> => {
    const project = credentialProject(credential);
    const key = catalogKey(credential);
    const existing = entries.get(key);
    if (existing?.pending) return existing.pending;
    if (existing && existing.until > now()) {
      if (existing.catalog) return existing.catalog;
      throw existing.error;
    }
    if (entries.size >= 4 && !entries.has(key)) {
      const inactive = [...entries].find(([, entry]) => !entry.pending);
      if (inactive) entries.delete(inactive[0]);
    }
    const entry: { catalog?: Catalog; error?: Error; until: number; pending?: Promise<Catalog> } = { until: 0 };
    entries.set(key, entry);
    entry.pending = (async () => {
      const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
      signal.throwIfAborted();
      const response = await fetcher(`${SUBSCRIPTION_ENDPOINT}/v1internal:fetchAvailableModels`, {
        method: "POST", headers: { Authorization: `Bearer ${credential.access}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ project }), redirect: "error", signal,
      });
      // Bound a private service catalog before parsing it. Empty models is an
      // authoritative empty catalog, not a reason to try another endpoint.
      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            signal.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 8 * 1024 * 1024) throw new Error("Subscription model catalog exceeded 8 MiB.");
            chunks.push(next.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        let payload: unknown;
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new Error("Subscription model discovery returned invalid JSON."); }
        entry.catalog = catalogFromPayload(payload);
      } else entry.catalog = catalogFromPayload(await jsonResponse(response, "Subscription model discovery"));
      entry.until = now() + 5 * 60_000;
      return entry.catalog;
    })().catch((error: unknown) => {
      entry.error = error instanceof Error ? error : new Error("Subscription model discovery failed.");
      entry.until = now() + 30_000;
      throw entry.error;
    }).finally(() => { entry.pending = undefined; });
    return entry.pending;
  };
}
