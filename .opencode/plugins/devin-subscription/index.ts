import { Plugin, Provider } from "@opencode/plugin";
import type { ConnectionInfo } from "@opencode/client";
import { fileURLToPath } from "node:url";
import { PROVIDER_ID, INTEGRATION_ID, IMPORT_METHOD_ID, ORIGIN, type Send } from "./constants.ts";
import { createCatalogLoader, identity, models } from "./catalog.ts";
import { connectionToken } from "./credentials.ts";
import { createHTTP } from "./http.ts";
import { startBridge } from "./bridge.ts";
import { subscriptionRequest } from "./request.ts";

export type Context = Pick<Plugin.Context, "provider" | "integration" | "session" | "event">;
const providerName = "Devin subscription (unofficial)";
export async function setup(ctx: Context, testing: { send?: Send; bridgeEnv?: NodeJS.ProcessEnv } = {}) {
  const lifecycle = new AbortController();
  const http = createHTTP();
  const send = testing.send ?? http.send;
  const bridge = await startBridge(send, { env: testing.bridgeEnv });
  const loadCatalog = createCatalogLoader(send);
  const inventory: { models: ReturnType<typeof models>; connection?: ConnectionInfo } = { models: [] };
  let discoveryFailed = false;
  let catalogIdentity: string | undefined;
  let revision = 0;
  const dispose = async () => { lifecycle.abort(); revision++; http.dispose(); await bridge.dispose(); };
  try {
  await ctx.provider.transform((editor) => editor.add({ info: {
    ...Provider.Info.empty(PROVIDER_ID), name: `${providerName}${discoveryFailed ? " · catalog lookup failed" : ""}`, integrationID: INTEGRATION_ID,
    activation: "enabled", package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `${ORIGIN}/v1`, transport: "http" },
  }, models: inventory.models, sourceConnection: inventory.connection }));
  await ctx.integration.transform((editor) => {
    editor.update(INTEGRATION_ID, (integration) => { integration.name = providerName; });
    editor.method.update({ integrationID: INTEGRATION_ID, method: {
      type: "key", label: "Devin Desktop session token (unofficial; suspension and billing risk)",
    } });
    if (process.platform === "darwin") editor.method.update({ integrationID: INTEGRATION_ID, method: {
      type: "command", id: IMPORT_METHOD_ID,
      label: "Import local Devin Desktop login (Keychain access; unofficial; suspension and billing risk)",
      command: [Bun.which("bun") ?? "bun", fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./import-command.ts" : "./import-command.js", import.meta.url)), "--opencode-auth-command"],
    } });
  });
  const active = async () => {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID);
    const value = connection ? await ctx.integration.connection.resolve(connection) : undefined;
    return { connection, token: connectionToken(value) };
  };
  const assertUnchanged = async (before: Awaited<ReturnType<typeof active>>) => {
    const current = await active();
    if (JSON.stringify(before.connection) !== JSON.stringify(current.connection) || identity(before.token) !== identity(current.token)) {
      throw new Error("The active Devin connection changed before dispatch. Retry manually; no account fallback was attempted.");
    }
  };
  const refreshInventory = async () => {
    const version = ++revision;
    const connection = await ctx.integration.connection.active(INTEGRATION_ID);
    if (version !== revision || lifecycle.signal.aborted) return;
    if (JSON.stringify(inventory.connection) !== JSON.stringify(connection)) {
      catalogIdentity = undefined;
      discoveryFailed = false;
      inventory.models = []; inventory.connection = connection; await ctx.provider.reload();
    }
    if (!connection || lifecycle.signal.aborted) return;
    let loaded: ReturnType<typeof models>;
    let loadedIdentity: string;
    try {
      const value = await ctx.integration.connection.resolve(connection);
      if (version !== revision || lifecycle.signal.aborted) return;
      if (catalogIdentity && (value?.type !== "key" || catalogIdentity !== identity(value.key))) {
        inventory.models = []; catalogIdentity = undefined; await ctx.provider.reload();
      }
      const before = { connection, token: connectionToken(value) };
      loaded = models(await loadCatalog(before.token, lifecycle.signal));
      loadedIdentity = identity(before.token);
      await assertUnchanged(before);
    } catch {
      // A failed read is not an authoritative empty catalog. Preserve this
      // connection's last choices with an explicit stale label; dispatch still
      // requires a fresh successful catalog. Never keep another account's list.
      if (version === revision && !lifecycle.signal.aborted && JSON.stringify(inventory.connection) === JSON.stringify(connection)) {
        discoveryFailed = true;
        inventory.models = inventory.models.map((model) => ({ ...model, name: model.name.replace(/ · catalog lookup failed$/, "") + " · catalog lookup failed" }));
        await ctx.provider.reload();
      }
      return;
    }
    if (version !== revision || lifecycle.signal.aborted) return;
    inventory.models = loaded; inventory.connection = connection; catalogIdentity = loadedIdentity; discoveryFailed = false; await ctx.provider.reload();
  };
  await ctx.session.hook("http.request", async (event) => {
    event.request.signal.throwIfAborted();
    const before = await active();
    const entries = await loadCatalog(before.token, AbortSignal.any([lifecycle.signal, event.request.signal]));
    await assertUnchanged(before);
    // A failed setup-time catalog read leaves the registered model list empty
    // until the next credential event. A dispatch-time success already fetched
    // this account's catalog, so recover the inventory here instead of making
    // the user re-login to repopulate it.
    if (!inventory.models.length) {
      revision++;
      inventory.models = models(entries); inventory.connection = before.connection;
      catalogIdentity = identity(before.token); discoveryFailed = false;
      await ctx.provider.reload();
    }
    event.request.signal.throwIfAborted();
    const job = await subscriptionRequest(event.request, before.token, event.sessionID, entries, event.model.id, event.model.variant);
    event.request = bridge.rewrite({ ...job, beforeSend: () => assertUnchanged(before) });
  }, { providerID: PROVIDER_ID });
  await ctx.session.hook("http.response", (event) => { event.response = bridge.adapt(event.request, event.response); }, { providerID: PROVIDER_ID });
  await ctx.session.hook("retry", (event) => { event.decision = { retry: false }; }, { providerID: PROVIDER_ID });
  void refreshInventory().catch(() => {});
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: lifecycle.signal })) {
      if (event.type === "credential.switched" && event.data.integrationID === INTEGRATION_ID) void refreshInventory().catch(() => {});
      if (event.type === "credential.updated") {
        const connection = await ctx.integration.connection.active(INTEGRATION_ID);
        const value = connection ? await ctx.integration.connection.resolve(connection) : undefined;
        const fingerprint = value?.type === "key" ? identity(value.key) : undefined;
        if (JSON.stringify(connection) !== JSON.stringify(inventory.connection) || fingerprint !== catalogIdentity) void refreshInventory().catch(() => {});
      }
    }
  })().catch(() => {});
  return dispose;
  } catch (error) { await dispose(); throw error; }
}
export default Plugin.define({ id: "opencode.provider.devin-subscription", setup });
