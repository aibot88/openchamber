import { Plugin, Provider, type Credential } from "@opencode/plugin";
import { BASE_URL, INTEGRATION_ID, METHOD_ID, PROVIDER_ID, TERMS_URL } from "./constants.ts";
import { subscriptionModels } from "./models.ts";
import { refreshCredential, startLoopbackAuthorization } from "./oauth.ts";
import { subscriptionRequest } from "./transport.ts";
import { createSubscriptionHTTP } from "./subscription-http.ts";
import { startSubscriptionBridge } from "./bridge.ts";
import { catalogKey, createCatalogLoader } from "./catalog.ts";
import type { ConnectionInfo } from "@opencode/client";
import type { Fetch } from "./google-http.ts";

export type Context = Pick<Plugin.Context, "provider" | "integration" | "session" | "event">;

export async function setup(ctx: Context, testing: { send?: Fetch } = {}) {
  const attempts = new Map<() => void, Promise<Credential.OAuth>>();
  const lifecycle = new AbortController();
  const http = createSubscriptionHTTP();
  // Test injection is programmatic only: no environment/config endpoint escape.
  const send = testing.send ?? http.fetch;
  const bridge = await startSubscriptionBridge(send);
  const loadCatalog = createCatalogLoader(send, { signal: lifecycle.signal });
  const unverifiedModels = subscriptionModels.map((model) => ({ ...model, name: `${model.name} · catalog not verified` }));
  const inventory: { models: typeof subscriptionModels; connection?: ConnectionInfo } = { models: unverifiedModels };
  let revision = 0;
  await ctx.provider.transform((editor) => {
    editor.add({
      info: {
        ...Provider.Info.empty(PROVIDER_ID),
        integrationID: INTEGRATION_ID,
        name: "Google AI Pro (unofficial)",
        activation: "enabled",
        package: "@opencode/ai/providers/google",
        settings: { baseURL: BASE_URL, transport: "http" },
      },
      models: inventory.models,
      sourceConnection: inventory.connection,
    });
  });
  await ctx.integration.transform((editor) => {
    for (const method of editor.method.list(INTEGRATION_ID)) {
      if (method.type === "key" || method.type === "env") editor.method.remove(INTEGRATION_ID, method);
    }
    editor.method.update({
      integrationID: INTEGRATION_ID,
      method: {
        type: "oauth",
        id: METHOD_ID,
        label: "Google subscription OAuth (unofficial; account suspension risk)",
      },
      authorize: async () => {
        // Replacing a canceled UI attempt releases its fixed callback port.
        for (const cancel of attempts.keys()) cancel();
        await Promise.allSettled(attempts.values());
        const attempt = await startLoopbackAuthorization();
        attempts.set(attempt.cancel, attempt.callback);
        void attempt.callback.finally(() => attempts.delete(attempt.cancel)).catch(() => {});
        return {
          url: attempt.url,
          instructions: `Unofficial subscription access violates Google's terms and may suspend your account. ${TERMS_URL}. Complete Google sign-in in the browser on this computer. Sign-in may initialize a Google-authorized managed project; it never creates a user-owned Cloud billing project or uses an API billing fallback.`,
          expiresAt: attempt.expiresAt,
          mode: "auto",
          callback: attempt.callback,
        };
      },
      refresh: (credential) => refreshCredential(credential),
      label: () => "Google subscription",
    });
  });
  await ctx.session.hook("http.request", async (event) => {
    const connection = await ctx.integration.connection.active(INTEGRATION_ID);
    const credential: Credential.Value | undefined = connection
      ? await ctx.integration.connection.resolve(connection)
      : undefined;
    if (credential?.type !== "oauth") throw new Error("Connect Google AI Pro (unofficial) before sending a subscription request.");
    event.request.signal.throwIfAborted();
    const catalog = await loadCatalog(credential);
    event.request.signal.throwIfAborted();
    const selected = await ctx.integration.connection.active(INTEGRATION_ID);
    if (JSON.stringify(selected) !== JSON.stringify(connection)) {
      throw new Error("Google subscription connection changed before dispatch. Retry manually; no account fallback was attempted.");
    }
    const request = await subscriptionRequest(event.request, credential, `${event.sessionID}:${event.kind}`, catalog, event.model.variant);
    event.request = bridge.rewrite(request);
  }, { providerID: PROVIDER_ID });
  await ctx.session.hook("http.response", async (event) => {
    event.response = bridge.adapt(event.request, event.response);
  }, { providerID: PROVIDER_ID });
  await ctx.session.hook("retry", (event) => {
    // The bridge submits once. Do not resubmit inference after ambiguous network
    // failures either: an upstream request may already have consumed quota.
    event.decision = { retry: false };
  }, { providerID: PROVIDER_ID });
  const refreshInventory = async () => {
    const version = ++revision;
    const connection = await ctx.integration.connection.active(INTEGRATION_ID);
    const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
    if (lifecycle.signal.aborted) return;
    let models: typeof subscriptionModels = unverifiedModels;
    if (credential?.type === "oauth") {
      try { models = (await loadCatalog(credential)).models; }
      catch { /* Keep configured choices, but dispatch remains catalog-gated. */ }
      const selected = await ctx.integration.connection.active(INTEGRATION_ID);
      if (JSON.stringify(selected) !== JSON.stringify(connection)) return;
      const current = selected ? await ctx.integration.connection.resolve(selected) : undefined;
      if (current?.type !== "oauth" || catalogKey(current) !== catalogKey(credential)) return;
    }
    if (version !== revision || lifecycle.signal.aborted) return;
    inventory.models = models;
    inventory.connection = connection;
    await ctx.provider.reload();
  };
  // No token files are inspected: the host resolves the selected connection.
  void refreshInventory().catch(() => {});
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: lifecycle.signal })) {
      if (event.type === "credential.updated" || (event.type === "credential.switched" && event.data.integrationID === INTEGRATION_ID)) {
        void refreshInventory().catch(() => {});
      }
    }
  })().catch(() => {});
  return async () => {
    lifecycle.abort();
    for (const cancel of attempts.keys()) cancel();
    attempts.clear();
    http.dispose();
    await bridge.dispose();
  };
}

export default Plugin.define({ id: "opencode.provider.google-ai-pro-subscription", setup });
