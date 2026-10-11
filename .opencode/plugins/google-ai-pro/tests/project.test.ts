import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@opencode/client";
import { ENDPOINT, ONBOARD_USER_AGENT, USER_AGENT } from "../constants.ts";
import type { Fetch } from "../google-http.ts";
import { resolveProject } from "../project.ts";

function fixture(responses: { payload: JsonValue; status?: number }[]) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const response = responses[requests.length - 1];
    if (!response) throw new Error("Unexpected additional request.");
    expect(new URL(String(input)).origin).toBe(ENDPOINT);
    expect(init?.redirect).toBe("error");
    return Response.json(response.payload, { status: response.status });
  };
  return { fetcher, requests };
}
const managed = { id: "managed-test-tier", isDefault: true, userDefinedCloudaicompanionProject: false };
const noWait = async (signal: AbortSignal) => { signal.throwIfAborted(); };
const expectedLookupUserAgent = `antigravity/hub/2.9.1 ${process.platform === "win32" ? "windows" : process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`;

describe("Antigravity managed project resolution", () => {
  test("uses the Hub lookup identity without changing the request body or destination", async () => {
    const mock = fixture([{ payload: { cloudaicompanionProject: "test-project" } }]);
    expect(await resolveProject("fake-access", mock.fetcher)).toBe("test-project");
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0];
    expect(request.url).toBe(`${ENDPOINT}/v1internal:loadCodeAssist`);
    expect(request.init?.method).toBe("POST");
    expect(Object.fromEntries(new Headers(request.init?.headers))).toEqual({
      authorization: "Bearer fake-access",
      "content-type": "application/json",
      "user-agent": expectedLookupUserAgent,
    });
    expect(JSON.parse(String(request.init?.body))).toEqual({ metadata: {
      ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI",
    } });
  });

  test("uses CLIProxyAPI's short runtime and long onboarding identities", async () => {
    const mock = fixture([
      { payload: { allowedTiers: [managed] } },
      { payload: { name: "operations/test", done: false } },
      { payload: { done: true } },
      { payload: { cloudaicompanionProject: "published-project" } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher, { wait: noWait })).toBe("published-project");
    expect(mock.requests.map((request) => new Headers(request.init?.headers).get("user-agent"))).toEqual([
      expectedLookupUserAgent, ONBOARD_USER_AGENT, USER_AGENT, expectedLookupUserAgent,
    ]);
    expect(mock.requests.map((request) => request.url)).toEqual([
      `${ENDPOINT}/v1internal:loadCodeAssist`, `${ENDPOINT}/v1internal:onboardUser`,
      `${ENDPOINT}/v1internal/operations/test`, `${ENDPOINT}/v1internal:loadCodeAssist`,
    ]);
  });

  test("accepts existing string, id and projectId references without onboarding", async () => {
    const references: JsonValue[] = [" test-project ", { id: " test-project " }, { projectId: "test-project" }, { id: "", projectId: "test-project" }];
    for (const reference of references) {
      const mock = fixture([{ payload: { cloudaicompanionProject: reference } }]);
      expect(await resolveProject("fake-access", mock.fetcher)).toBe("test-project");
      expect(mock.requests).toHaveLength(1);
    }
  });

  test("onboards the server's explicitly managed default exactly once", async () => {
    const mock = fixture([
      { payload: { cloudaicompanionProject: null, currentTier: null, allowedTiers: [{ id: "cloud", userDefinedCloudaicompanionProject: true }, managed], ineligibleTiers: null } },
      { payload: { done: true, response: { cloudaicompanionProject: { id: "managed-project" } } } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher)).toBe("managed-project");
    expect(mock.requests.map((request) => request.url)).toEqual([
      `${ENDPOINT}/v1internal:loadCodeAssist`, `${ENDPOINT}/v1internal:onboardUser`,
    ]);
    expect(JSON.parse(String(mock.requests[1].init?.body))).toEqual({
      tierId: managed.id,
      metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
    });
  });

  test("supports the documented free-tier managed project without supplying a Cloud project", async () => {
    const mock = fixture([
      { payload: { allowedTiers: [{ id: "free-tier", isDefault: true }] } },
      { payload: { response: { cloudaicompanionProject: "managed-project" } } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher)).toBe("managed-project");
    expect(JSON.parse(String(mock.requests[1].init?.body))).not.toHaveProperty("cloudaicompanionProject");
  });

  test("can repair an existing server-declared managed tier missing its project", async () => {
    const mock = fixture([
      { payload: { currentTier: managed } },
      { payload: { done: true, response: { cloudaicompanionProject: { projectId: "managed-project" } } } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher)).toBe("managed-project");
  });

  test("polls the operation with GET instead of repeating onboarding POSTs", async () => {
    const mock = fixture([
      { payload: { allowedTiers: [managed] } },
      { payload: { name: "operations/test-onboard", done: false } },
      { payload: { name: "operations/test-onboard", done: false } },
      { payload: { done: true, response: { cloudaicompanionProject: "managed-project" } } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher, { wait: noWait })).toBe("managed-project");
    expect(mock.requests.map((request) => request.init?.method)).toEqual(["POST", "POST", "GET", "GET"]);
    expect(mock.requests.slice(2).map((request) => request.url)).toEqual([
      `${ENDPOINT}/v1internal/operations/test-onboard`, `${ENDPOINT}/v1internal/operations/test-onboard`,
    ]);
  });

  test("does not treat a pending operation's project as completed", async () => {
    const mock = fixture([
      { payload: { allowedTiers: [managed] } },
      { payload: { name: "operations/test", done: false, response: { cloudaicompanionProject: "not-ready" } } },
      { payload: { done: true, response: { cloudaicompanionProject: "ready" } } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher, { wait: noWait })).toBe("ready");
    expect(mock.requests).toHaveLength(3);
  });

  test("accepts a project-scoped operation without following a foreign host", async () => {
    const name = "projects/test/locations/global/operations/test-onboard";
    const mock = fixture([
      { payload: { allowedTiers: [managed] } },
      { payload: { name, done: false } },
      { payload: { done: true, response: { cloudaicompanionProject: "ready" } } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher, { wait: noWait })).toBe("ready");
    expect(mock.requests[2].url).toBe(`${ENDPOINT}/v1internal/${name}`);
  });

  test("rechecks discovery when completed onboarding does not include a project", async () => {
    const mock = fixture([
      { payload: { allowedTiers: [managed] } },
      { payload: { done: true } },
      { payload: { cloudaicompanionProject: "published-project" } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher)).toBe("published-project");
    expect(mock.requests[2].url).toBe(`${ENDPOINT}/v1internal:loadCodeAssist`);
  });

  test("bounds pending operations to ten reads without duplicate onboarding", async () => {
    const pending = { payload: { name: "operations/test", done: false } };
    const mock = fixture([{ payload: { allowedTiers: [managed] } }, pending, ...Array.from({ length: 10 }, () => pending)]);
    await expect(resolveProject("fake-access", mock.fetcher, { wait: noWait })).rejects.toThrow("still pending");
    expect(mock.requests.filter((request) => request.url.endsWith(":onboardUser"))).toHaveLength(1);
    expect(mock.requests.filter((request) => request.init?.method === "GET")).toHaveLength(10);
  });

  test("never invents a project when onboarding and rediscovery have no ID", async () => {
    const mock = fixture([
      { payload: { allowedTiers: [managed] } },
      { payload: { done: true } },
      { payload: { cloudaicompanionProject: null } },
    ]);
    await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow("did not invent a project ID");
    expect(mock.requests).toHaveLength(3);
  });

  test("operation errors take precedence over a project and do not leak server messages", async () => {
    const mock = fixture([
      { payload: { allowedTiers: [managed] } },
      { payload: { done: true, error: { code: 7, message: "private-token-test; private@example.invalid" }, response: { cloudaicompanionProject: "must-not-use" } } },
    ]);
    await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow(
      /^Antigravity managed onboarding failed \(RPC code 7\)\. No API fallback was attempted\.$/,
    );
    expect(mock.requests).toHaveLength(2);
  });

  test("rejects foreign URLs, traversal and malformed operation references", async () => {
    for (const name of ["https://attacker.invalid/steal", "//attacker.invalid/steal", "operations/../steal", "operations/%2e%2e/steal", "operations/test?token=private", "operations/test#private", "operations/", "operations\\steal", "../operations/test"]) {
      const mock = fixture([{ payload: { allowedTiers: [managed] } }, { payload: { done: false, name } }]);
      await expect(resolveProject("fake-access", mock.fetcher, { wait: noWait })).rejects.toThrow("invalid operation reference");
      expect(mock.requests).toHaveLength(2);
    }
  });

  test("refuses guessed tiers when no usable default was returned", async () => {
    const payloads: JsonValue[] = [{}, { cloudaicompanionProject: null, allowedTiers: null, currentTier: null }, { allowedTiers: [managed, { ...managed, id: "other" }].map((tier) => ({ ...tier, isDefault: false })) }];
    for (const payload of payloads) {
      const mock = fixture([{ payload }]);
      await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow("no Antigravity project or usable default");
      expect(mock.requests).toHaveLength(1);
    }
  });

  test("never chooses a different tier to bypass a user-owned Cloud project requirement", async () => {
    const tiers: JsonValue[] = [
      { id: "free-tier", isDefault: true, userDefinedCloudaicompanionProject: true },
      { id: "standard-tier", isDefault: true, userDefinedCloudaicompanionProject: true },
      { id: "unknown-tier", isDefault: true },
    ];
    for (const tier of tiers) {
      const mock = fixture([{ payload: { allowedTiers: [tier, { ...managed, isDefault: false }] } }]);
      await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow("did not authorize managed onboarding");
      expect(mock.requests).toHaveLength(1);
    }
  });

  test("reports client rejection explicitly and never onboards around it", async () => {
    for (const reasonCode of ["GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT", "UNSUPPORTED_CLIENT"]) {
      const mock = fixture([{ payload: { allowedTiers: [managed], ineligibleTiers: [{ reasonCode, reasonMessage: "private-token-test" }] } }]);
      await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow(
        `Antigravity project lookup rejected this request's client identification (${reasonCode}). No onboarding or API fallback was attempted.`,
      );
      expect(mock.requests).toHaveLength(1);
    }
  });

  test("reports known account restrictions without sharing Google's message or URLs", async () => {
    const mock = fixture([{ payload: { allowedTiers: [managed], ineligibleTiers: [{ reasonCode: "VALIDATION_REQUIRED", reasonMessage: "private@example.invalid", validationUrl: "https://example.invalid/private" }] } }]);
    await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow(
      /^Antigravity account eligibility \(VALIDATION_REQUIRED\): Verify the Google account in the official Antigravity app, then reconnect\.$/,
    );
    expect(mock.requests).toHaveLength(1);
  });

  test("does not mistake an unrelated ineligible tier for a block on the managed tier", async () => {
    const mock = fixture([
      { payload: { allowedTiers: [managed], ineligibleTiers: [{ tierId: "another-tier", reasonCode: "INELIGIBLE_ACCOUNT" }] } },
      { payload: { done: true, response: { cloudaicompanionProject: "managed-project" } } },
    ]);
    expect(await resolveProject("fake-access", mock.fetcher)).toBe("managed-project");
  });

  test("stops on unknown eligibility codes without echoing them or initializing the account", async () => {
    const mock = fixture([{ payload: { allowedTiers: [managed], ineligibleTiers: [{ reasonCode: "private-token-test" }] } }]);
    await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow(
      /^Google returned no Antigravity project and an unrecognized eligibility restriction\. Complete setup in the official Antigravity app; no onboarding or API fallback was attempted\.$/,
    );
    expect(mock.requests).toHaveLength(1);
  });

  test("does not accept a service notice on the user's behalf", async () => {
    const tiers: JsonValue[] = [
      { ...managed, privacyNotice: { showNotice: true }, hasAcceptedTos: false },
      { ...managed, privacyNotice: { showNotice: true } },
      { ...managed, hasAcceptedTos: false },
    ];
    for (const tier of tiers) {
      const mock = fixture([{ payload: { allowedTiers: [tier] } }]);
      await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow("requires acceptance of a service notice");
      expect(mock.requests).toHaveLength(1);
    }
  });

  test("distinguishes malformed lookup and operation payloads from missing projects", async () => {
    const payloads: JsonValue[] = [{ cloudaicompanionProject: 42 }, { allowedTiers: "not-an-array" }];
    for (const payload of payloads) {
      const mock = fixture([{ payload }]);
      await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow("invalid payload, not a missing project");
      expect(mock.requests).toHaveLength(1);
    }
    const mock = fixture([{ payload: { allowedTiers: [managed] } }, { payload: { done: "yes" } }]);
    await expect(resolveProject("fake-access", mock.fetcher)).rejects.toThrow("invalid operation payload");
    expect(mock.requests).toHaveLength(2);
  });

  test("preserves lookup and onboarding HTTP errors without fallback", async () => {
    for (const status of [401, 403, 429, 503]) {
      const load = fixture([{ payload: {}, status }]);
      await expect(resolveProject("fake-access", load.fetcher)).rejects.toThrow(`Antigravity project lookup failed (${status})`);
      expect(load.requests).toHaveLength(1);
      const onboard = fixture([{ payload: { allowedTiers: [managed] } }, { payload: {}, status }]);
      await expect(resolveProject("fake-access", onboard.fetcher)).rejects.toThrow(`Antigravity managed onboarding failed (${status})`);
      expect(onboard.requests).toHaveLength(2);
    }
  });

  test("cancellation stops operation polling before another token-bearing request", async () => {
    const controller = new AbortController();
    const mock = fixture([{ payload: { allowedTiers: [managed] } }, { payload: { name: "operations/test", done: false } }]);
    await expect(resolveProject("fake-access", mock.fetcher, {
      signal: controller.signal,
      wait: async () => { controller.abort(); },
    })).rejects.toThrow();
    expect(mock.requests).toHaveLength(2);
  });

  test("an already canceled sign-in sends no project requests", async () => {
    const mock = fixture([]);
    await expect(resolveProject("fake-access", mock.fetcher, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(mock.requests).toHaveLength(0);
  });
});
