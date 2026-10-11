import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ENDPOINT, ONBOARD_USER_AGENT, PROJECT_LOOKUP_USER_AGENT, USER_AGENT } from "./constants.ts";
import { jsonResponse, type Fetch } from "./google-http.ts";

const metadata = {
  ideType: "ANTIGRAVITY",
  // This is a protobuf enum, not an OS label. MACOS / WINDOWS are invalid.
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};
const projectReference = z.union([
  z.string().trim(),
  z.object({ id: z.string().trim().optional(), projectId: z.string().trim().optional() }),
]).nullish();
const tierSchema = z.object({
  id: z.string().trim().optional(),
  isDefault: z.boolean().optional(),
  userDefinedCloudaicompanionProject: z.boolean().nullish(),
  hasAcceptedTos: z.boolean().nullish(),
  privacyNotice: z.object({ showNotice: z.boolean().optional() }).nullish(),
});
const loadSchema = z.object({
  cloudaicompanionProject: projectReference,
  currentTier: tierSchema.nullish(),
  allowedTiers: z.array(tierSchema).nullish(),
  ineligibleTiers: z.array(z.object({
    reasonCode: z.string().optional(),
    tierId: z.string().optional(),
  })).nullish(),
});
const operationSchema = z.object({
  name: z.string().optional(),
  done: z.boolean().optional(),
  response: z.object({ cloudaicompanionProject: projectReference }).nullish(),
  error: z.object({ code: z.number().int().min(0).max(16).optional() }).nullish(),
});

function projectId(reference: z.infer<typeof projectReference>): string | undefined {
  if (typeof reference === "string") return reference || undefined;
  return reference?.id || reference?.projectId || undefined;
}

function rejectUnsupportedClient(payload: z.infer<typeof loadSchema>) {
  for (const reason of ["GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT", "UNSUPPORTED_CLIENT"]) {
    if (payload.ineligibleTiers?.some((tier) => tier.reasonCode === reason)) {
      throw new Error(`Antigravity project lookup rejected this request's client identification (${reason}). No onboarding or API fallback was attempted.`);
    }
  }
}

// Each message and code is local and allowlisted; server descriptions and URLs
// may contain account identifiers and must never be included in errors or logs.
const eligibilityMessages = new Map([
  ["VALIDATION_REQUIRED", "Verify the Google account in the official Antigravity app, then reconnect."],
  ["RESTRICTED_AGE", "Google's age requirements block this account."],
  ["UNSUPPORTED_LOCATION", "Google does not support this account's location."],
  ["UNKNOWN_LOCATION", "Google could not verify the account's location."],
  ["RESTRICTED_NETWORK", "Google has restricted access from this network."],
  ["INELIGIBLE_ACCOUNT", "Google marked this account as ineligible for this service."],
  ["DASHER_USER", "Google requires a different sign-in flow for this Workspace account."],
  ["NON_USER_ACCOUNT", "A personal Google user account is required."],
]);

function operationPath(name: string): string {
  // Only follow same-service operation resources. Never trust a response URL,
  // traversal segment, query, fragment or a redirect with a bearer credential.
  const segments = name.split("/");
  if (segments.length < 2 || segments[segments.length - 2] !== "operations" || segments.some((segment) =>
    !/^[A-Za-z0-9._~-]+$/.test(segment) || segment === "." || segment === "..")) {
    throw new Error("Antigravity onboarding returned an invalid operation reference.");
  }
  return `/v1internal/${segments.map(encodeURIComponent).join("/")}`;
}

export async function resolveProject(access: string, fetcher: Fetch, options: {
  signal?: AbortSignal;
  wait?: (signal: AbortSignal) => Promise<void>;
} = {}): Promise<string> {
  // Bound the entire provisioning flow, not just each request. Cancellation
  // after the OAuth callback must stop token-bearing requests and polling too.
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const wait = options.wait ?? (async (signal: AbortSignal) => { await delay(2000, undefined, { signal }); });
  const request = async (path: string, description: string, body?: { metadata: typeof metadata; tierId?: string }) => {
    signal.throwIfAborted();
    const response = await fetcher(`${ENDPOINT}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
        "User-Agent": path === "/v1internal:onboardUser" ? ONBOARD_USER_AGENT :
          path === "/v1internal:loadCodeAssist" ? PROJECT_LOOKUP_USER_AGENT : USER_AGENT,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: "error",
    });
    signal.throwIfAborted();
    return jsonResponse(response, description);
  };
  const load = async () => {
    const parsed = loadSchema.safeParse(await request("/v1internal:loadCodeAssist", "Antigravity project lookup", { metadata }));
    if (!parsed.success) throw new Error("Antigravity project lookup returned an invalid payload, not a missing project.");
    rejectUnsupportedClient(parsed.data);
    return parsed.data;
  };
  const initial = await load();
  const existing = projectId(initial.cloudaicompanionProject);
  if (existing) return existing;

  const tiers = initial.allowedTiers ?? [];
  // Do not silently choose another tier when a default requires a Cloud project.
  const tier = tiers.find((tier) => tier.isDefault)
    ?? (tiers.length === 1 ? tiers[0] : tiers.length === 0 ? initial.currentTier : undefined);
  const reasons = (initial.ineligibleTiers ?? []).filter((reason) => !tier?.id || !reason.tierId || reason.tierId === tier.id);
  for (const reason of reasons) {
    const message = eligibilityMessages.get(reason.reasonCode ?? "");
    if (message) throw new Error(`Antigravity account eligibility (${reason.reasonCode}): ${message}`);
  }
  if (reasons.length > 0) throw new Error("Google returned no Antigravity project and an unrecognized eligibility restriction. Complete setup in the official Antigravity app; no onboarding or API fallback was attempted.");
  if (!tier?.id) throw new Error("Google returned no Antigravity project or usable default onboarding tier. Complete setup in the official Antigravity app, then reconnect.");
  // Only initialize a server-declared managed tier or the documented free-tier
  // managed project. Never provision a user-owned, billable Cloud project.
  if (tier.userDefinedCloudaicompanionProject === true ||
    (tier.userDefinedCloudaicompanionProject !== false && tier.id !== "free-tier")) {
    throw new Error("Google returned no Antigravity project and did not authorize managed onboarding. This subscription provider will not create or configure a Google Cloud billing project.");
  }
  if (tier.hasAcceptedTos === false || (tier.privacyNotice?.showNotice && tier.hasAcceptedTos !== true)) {
    throw new Error("Google requires acceptance of a service notice. Complete it in the official Antigravity app, then reconnect; the plugin will not accept it for you.");
  }

  // The user authorized managed onboarding. Submit once; pending work is read
  // through Google's long-running-operation resource, never repeated POSTs.
  let payload = await request("/v1internal:onboardUser", "Antigravity managed onboarding", { tierId: tier.id, metadata });
  for (let attempt = 0; ; attempt++) {
    const parsed = operationSchema.safeParse(payload);
    if (!parsed.success) throw new Error("Antigravity onboarding returned an invalid operation payload.");
    const operation = parsed.data;
    if (operation.error) {
      const code = operation.error.code;
      throw new Error(`Antigravity managed onboarding failed${code === undefined ? "" : ` (RPC code ${code})`}. No API fallback was attempted.`);
    }
    const managed = projectId(operation.response?.cloudaicompanionProject);
    if (managed && operation.done !== false) return managed;
    if (operation.done === true || !operation.name) {
      const refreshed = await load();
      const resolved = projectId(refreshed.cloudaicompanionProject);
      if (resolved) return resolved;
      throw new Error("Antigravity onboarding returned no completed project. Complete setup in the official app and reconnect; the plugin did not invent a project ID.");
    }
    if (attempt >= 10) throw new Error("Antigravity managed onboarding is still pending. Wait for setup to finish, then reconnect; no duplicate onboarding request or API fallback was sent.");
    const path = operationPath(operation.name);
    await wait(signal);
    signal.throwIfAborted();
    payload = await request(path, "Antigravity onboarding status");
  }
}
