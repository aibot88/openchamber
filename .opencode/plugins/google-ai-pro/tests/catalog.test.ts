import { describe, expect, test } from "bun:test";
import type { Credential } from "@opencode/plugin";
import { catalogFromPayload, catalogKey, createCatalogLoader } from "../catalog.ts";
import { METHOD_ID, SUBSCRIPTION_ENDPOINT, USER_AGENT } from "../constants.ts";

const credential: Credential.OAuth = {
  type: "oauth", methodID: METHOD_ID, access: "fixture-access", refresh: "fixture-refresh",
  expires: Date.now() + 3_600_000, metadata: { projectId: "fixture-project" },
};
const payload = { models: {
  "gemini-3.1-pro-low": {}, "gemini-pro-agent": {},
  "gemini-3.8-flash-low": {}, "gemini-3.8-flash-medium": {}, "gemini-3.8-flash-high": {},
  "claude-opus-4-6": {}, "gpt-oss-120b": {},
} };

describe("account subscription catalog", () => {
  test("filters to the supported Gemini families and resolves the captured variant routes", () => {
    const catalog = catalogFromPayload(payload);
    expect([...catalog.routes.keys()]).toEqual(["gemini-3.1-pro", "gemini-3.8-flash"]);
    expect(catalog.routes.get("gemini-3.1-pro")?.get("high")).toBe("gemini-pro-agent");
    expect(catalog.routes.get("gemini-3.8-flash")?.get("medium")).toBe("gemini-3.8-flash-medium");
    expect(catalog.models.every((model) => model.enabled)).toBe(true);
  });

  test("accepts the tiered route only when the selected account actually reports it", () => {
    const catalog = catalogFromPayload({ models: { "gemini-3.8-flash-tiered": {} } });
    expect(catalog.routes.get("gemini-3.8-flash")?.get("medium")).toBe("gemini-3.8-flash-tiered");
    expect(catalog.models[0].enabled).toBe(false);
    expect(catalog.routes.get("gemini-3.1-pro")?.size).toBe(0);
  });

  test("treats an empty catalog as authoritative and does not change an unavailable default", () => {
    expect(catalogFromPayload({ models: {} }).models.every((model) => !model.enabled)).toBe(true);
    const catalog = catalogFromPayload({ models: { "gemini-3.8-flash-low": {} } });
    expect(catalog.models[1].variants.map((variant) => String(variant.id))).toEqual(["low"]);
    expect(catalog.models[1].settings?.thinkingConfig).toEqual({ thinkingBudget: 4000, includeThoughts: true });
    expect(catalog.routes.get("gemini-3.8-flash")?.has("medium")).toBe(false);
  });

  test("does not confuse a legacy/malformed response with a usable model directory", () => {
    for (const value of [{}, { models: null }, { models: [] }, { models: "bad" }]) {
      expect(() => catalogFromPayload(value)).toThrow("invalid catalog");
    }
  });

  test("queries daily exactly once, sends the server project, caches by account/project not access-token lifetime", async () => {
    let calls = 0;
    const load = createCatalogLoader(async (input, init) => {
      calls++;
      expect(String(input)).toBe(`${SUBSCRIPTION_ENDPOINT}/v1internal:fetchAvailableModels`);
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ project: "fixture-project" });
      expect(new Headers(init?.headers).get("user-agent")).toBe(USER_AGENT);
      return Response.json(payload);
    });
    const [a, b] = await Promise.all([load(credential), load(credential)]);
    expect(a).toBe(b);
    expect(await load({ ...credential, access: "rotated-access" })).toBe(a);
    expect(calls).toBe(1);
    expect(catalogKey({ ...credential, refresh: "other-account" })).not.toBe(catalogKey(credential));
    expect(catalogKey({ ...credential, metadata: { projectId: "other-project" } })).not.toBe(catalogKey(credential));
  });

  test("never queries another endpoint/account on 3501, authentication or quota denial", async () => {
    for (const status of [401, 403, 429, 503]) {
      let calls = 0;
      const load = createCatalogLoader(async () => {
        calls++;
        return Response.json({ error: { status: "PERMISSION_DENIED", message: "private@example.invalid valid license (#3501)" } }, { status });
      });
      await expect(load(credential)).rejects.toThrow(`(${status}; PERMISSION_DENIED)`);
      await expect(load(credential)).rejects.toThrow(`(${status}; PERMISSION_DENIED)`);
      expect(calls).toBe(1);
    }
  });

  test("refreshes expired success and failure caches without a background retry loop", async () => {
    let time = 0;
    let calls = 0;
    const load = createCatalogLoader(async () => { calls++; return Response.json(payload); }, { now: () => time });
    await load(credential); time += 300_001; await load(credential);
    expect(calls).toBe(2);
  });

  test("stops discovery on lifecycle cancellation and rejects guessed/missing projects", async () => {
    let calls = 0;
    const load = createCatalogLoader(async () => { calls++; return Response.json(payload); }, { signal: AbortSignal.abort() });
    await expect(load(credential)).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(load({ ...credential, metadata: {} })).rejects.toThrow("no project");
  });
});
