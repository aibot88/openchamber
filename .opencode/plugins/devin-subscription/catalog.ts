import { createHash } from "node:crypto";
import { Model } from "@opencode/plugin";
import { CATALOG_PATH, ORIGIN, PROVIDER_ID, type Send } from "./constants.ts";
import { fields, bytes, message, string, number, type Field } from "./protobuf.ts";
import { metadata, readLimited } from "./connect.ts";

export interface CatalogEntry { selector: string; label: string; alias: string; limit: Model.Info["limit"] }
export const identity = (token: string) => createHash("sha256").update(token).digest("hex");

// The public Devin Desktop schema defines both max_tokens fields as int32.
// Protobuf's missing/zero default carries no usable limit. Never guess by name.
function tokenLimit(source: Field[], tag: number): number {
  const value = number(source, tag) ?? 0;
  if (value > 0x7fffffff) throw new Error("Invalid Devin catalog token limit.");
  return value;
}

export function decodeCatalog(raw: Uint8Array): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const selectors = new Set<string>();
  for (const field of fields(raw)) {
    if (field.tag !== 1) continue;
    if (field.wire !== 2 || selectors.size >= 1024) throw new Error("Invalid or oversized Devin model catalog.");
    const config = fields(field.value);
    const selector = string(config, 22);
    if (!selector || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(selector) || selectors.has(selector)) throw new Error("Missing, invalid or duplicate Devin model selector.");
    selectors.add(selector);
    const disabled = number(config, 4);
    if (disabled !== undefined && disabled !== 0 && disabled !== 1) throw new Error("Invalid Devin model disabled flag.");
    if (disabled === 1) continue;
    const info = message(config, 23);
    const label = string(config, 1) || selector;
    const modelInfo = info ? fields(info) : [];
    const alias = string(modelInfo, 23) ?? "";
    if (label.length > 256 || alias.length > 256 || /[\x00-\x1f\x7f]/.test(label + alias)) throw new Error("Invalid Devin model label.");
    const contexts = [tokenLimit(config, 18), tokenLimit(modelInfo, 4)].filter((value) => value > 0);
    entries.push({ selector, label, alias, limit: {
      // Respect the tighter client/route bound if the catalog supplies both.
      context: contexts.length ? Math.min(...contexts) : 0,
      output: tokenLimit(modelInfo, 13),
    } });
  }
  return entries;
}

export function models(entries: readonly CatalogEntry[]): Model.Info[] {
  return entries.map((entry) => ({
    ...Model.Info.default(PROVIDER_ID, Model.ID.make(entry.selector)),
    name: `${entry.label} · Devin (entitlement/billing unverified)${!entry.limit.context || !entry.limit.output ? " · token limits not fully reported" : ""}`, status: "beta",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { ...entry.limit },
  }));
}

export function createCatalogLoader(send: Send) {
  const inFlight = new Map<string, { result: Promise<CatalogEntry[]>; controller: AbortController; readers: number }>();
  return (token: string, signal: AbortSignal): Promise<CatalogEntry[]> => {
    signal.throwIfAborted();
    const key = identity(token);
    let shared = inFlight.get(key);
    if (!shared) {
      if (inFlight.size >= 64) throw new Error("Too many concurrent Devin catalog identities.");
      const controller = new AbortController();
      const result = (async () => {
        const response = await send(new Request(ORIGIN + CATALOG_PATH, { method: "POST",
          headers: { Authorization: `Basic ${token}-${token}`, "Content-Type": "application/proto" },
          body: new Uint8Array(bytes(1, metadata(token))), signal: controller.signal, redirect: "error" }));
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Devin catalog lookup failed (HTTP ${response.status}). No account fallback was attempted.`); }
        return decodeCatalog(await readLimited(response));
      })();
      shared = { result, controller, readers: 0 };
      inFlight.set(key, shared);
      void result.finally(() => { if (inFlight.get(key)?.result === result) inFlight.delete(key); }).catch(() => {});
    }
    const current = shared;
    current.readers++;
    return new Promise<CatalogEntry[]>((resolve, reject) => {
      const cancel = () => reject(new Error("Devin catalog lookup canceled."));
      signal.addEventListener("abort", cancel, { once: true });
      void current.result.then(
        (entries) => { signal.removeEventListener("abort", cancel); resolve(entries); },
        (error) => { signal.removeEventListener("abort", cancel); reject(error); },
      );
      if (signal.aborted) cancel();
    }).finally(() => {
      // Each consumer owns its wait. One canceled session cannot cancel a
      // discovery still required by another session or the provider inventory.
      current.readers--;
      if (!current.readers) {
        current.controller.abort();
        if (inFlight.get(key) === current) inFlight.delete(key);
      }
    });
  };
}
