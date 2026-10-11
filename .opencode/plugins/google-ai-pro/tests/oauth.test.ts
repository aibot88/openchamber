import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { callbackCode, createAuthorization, exchangeCode, refreshCredential, startLoopbackAuthorization, type Fetch } from "../oauth.ts";
import { ENDPOINT, METHOD_ID } from "../constants.ts";

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("subscription OAuth", () => {
  test("uses PKCE and opaque state without exposing the verifier", () => {
    const first = createAuthorization();
    const second = createAuthorization();
    const url = new URL(first.url);
    expect(first.url).not.toContain(first.verifier);
    expect(url.searchParams.get("state")).toBe(first.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(first.state).not.toBe(second.state);
    expect(first.verifier).not.toBe(second.verifier);
  });

  test("requires the exact callback address, matching state and a code", () => {
    const attempt = createAuthorization();
    const valid = `${attempt.redirectURI}?state=${attempt.state}&code=test-code`;
    expect(callbackCode(valid, attempt.state, attempt.redirectURI)).toBe("test-code");
    for (const url of [
      `${attempt.redirectURI}?state=wrong&code=bad`,
      `https://attacker.invalid/oauth-callback?state=${attempt.state}&code=bad`,
      `${attempt.redirectURI}?state=${attempt.state}&error=access_denied`,
      `${attempt.redirectURI}?state=${attempt.state}`,
    ]) expect(() => callbackCode(url, attempt.state, attempt.redirectURI)).toThrow();
  });

  test("exchanges a fresh code and project without reading existing CLI credentials", async () => {
    const urls: string[] = [];
    const fetcher: Fetch = async (input, init) => {
      urls.push(String(input));
      expect(init?.redirect).toBe("error");
      if (urls.length === 1) {
        expect(new URLSearchParams(String(init?.body)).get("code")).toBe("test-code");
        return Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 });
      }
      expect(JSON.parse(String(init?.body))).toEqual({ metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      } });
      return Response.json({ cloudaicompanionProject: { id: "test-project" } });
    };
    const result = await exchangeCode("test-code", createAuthorization(), fetcher);
    expect(urls).toEqual(["https://oauth2.googleapis.com/token", `${ENDPOINT}/v1internal:loadCodeAssist`]);
    expect(result.methodID).toBe(METHOD_ID);
    expect(result.metadata?.projectId).toBe("test-project");
    expect(result.refresh).toBe("fake-refresh");
  });

  test("fails without a refresh token or project; never invents a project", async () => {
    await expect(exchangeCode("test", createAuthorization(), async () => Response.json({ access_token: "fake", expires_in: 3600 }))).rejects.toThrow("refresh token");
    let count = 0;
    await expect(exchangeCode("test", createAuthorization(), async () => ++count === 1
      ? Response.json({ access_token: "fake", refresh_token: "fake-refresh", expires_in: 3600 })
      : Response.json({}))).rejects.toThrow("no Antigravity project");
  });

  test("does not include Google response bodies or tokens in error messages", async () => {
    try {
      await exchangeCode("test", createAuthorization(), async () => new Response("private-token-test", { status: 403 }));
      throw new Error("Expected failure");
    } catch (error) {
      expect(String(error)).toContain("403");
      expect(String(error)).not.toContain("private-token-test");
    }
  });

  test("also accepts a string project ID with the corrected metadata", async () => {
    const fetcher: Fetch = async (input, init) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "fake", refresh_token: "fake-refresh", expires_in: 3600 });
      }
      expect(JSON.parse(String(init?.body)).metadata.platform).toBe("PLATFORM_UNSPECIFIED");
      return Response.json({ cloudaicompanionProject: "test-project" });
    };
    const result = await exchangeCode("test", createAuthorization(), fetcher);
    expect(result.metadata?.projectId).toBe("test-project");
  });

  test("completes OAuth only after authorized managed onboarding returns a real project", async () => {
    const urls: string[] = [];
    const fetcher: Fetch = async (input) => {
      urls.push(String(input));
      if (urls.length === 1) return Response.json({ access_token: "fake", refresh_token: "fake-refresh", expires_in: 3600 });
      if (urls.length === 2) return Response.json({ allowedTiers: [{ id: "free-tier", isDefault: true }] });
      return Response.json({ done: true, response: { cloudaicompanionProject: { id: "managed-project" } } });
    };
    const result = await exchangeCode("test", createAuthorization(), fetcher);
    expect(result.metadata?.projectId).toBe("managed-project");
    expect(result.refresh).toBe("fake-refresh");
    expect(urls).toEqual(["https://oauth2.googleapis.com/token", `${ENDPOINT}/v1internal:loadCodeAssist`, `${ENDPOINT}/v1internal:onboardUser`]);
  });

  test("reports a safe RPC status on project lookup failure without retries or API fallback", async () => {
    const urls: string[] = [];
    const fetcher: Fetch = async (input) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return Response.json({ access_token: "private-token-test", refresh_token: "fake-refresh", expires_in: 3600 });
      }
      return Response.json({ error: {
        status: "INVALID_ARGUMENT",
        message: "Private account private@example.invalid; private-token-test",
        details: [{ validationUrl: "https://example.invalid/private" }],
      } }, { status: 400 });
    };
    await expect(exchangeCode("test", createAuthorization(), fetcher)).rejects.toThrow(
      /^Antigravity project lookup failed \(400; INVALID_ARGUMENT\)\.$/,
    );
    expect(urls).toEqual(["https://oauth2.googleapis.com/token", `${ENDPOINT}/v1internal:loadCodeAssist`]);
  });

  test("stops OAuth on a client compatibility rejection without retrying or inventing a project", async () => {
    const urls: string[] = [];
    await expect(exchangeCode("test", createAuthorization(), async (input) => {
      urls.push(String(input));
      if (urls.length === 1) return Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 });
      return Response.json({
        allowedTiers: [{ id: "standard-tier", isDefault: true, userDefinedCloudaicompanionProject: true }],
        ineligibleTiers: [{ tierId: "free-tier", reasonCode: "UNSUPPORTED_CLIENT", reasonMessage: "private-token-test" }],
      });
    })).rejects.toThrow(
      /^Antigravity project lookup rejected this request's client identification \(UNSUPPORTED_CLIENT\)\. No onboarding or API fallback was attempted\.$/,
    );
    expect(urls).toEqual(["https://oauth2.googleapis.com/token", `${ENDPOINT}/v1internal:loadCodeAssist`]);
  });

  test("omits unrecognized or malformed server error details", async () => {
    for (const response of [
      Response.json({ error: { status: "private-token-test", message: "private@example.invalid" } }, { status: 400 }),
      new Response("private-token-test", { status: 400 }),
    ]) {
      let count = 0;
      await expect(exchangeCode("test", createAuthorization(), async () => ++count === 1
        ? Response.json({ access_token: "fake", refresh_token: "fake-refresh", expires_in: 3600 })
        : response)).rejects.toThrow(/^Antigravity project lookup failed \(400\)\.$/);
      expect(count).toBe(2);
    }
  });

  test("preserves metadata and rotates refresh tokens when provided", async () => {
    const result = await refreshCredential({ type: "oauth", methodID: METHOD_ID, access: "old", refresh: "old-refresh", expires: 0, metadata: { projectId: "same-project" } },
      async () => Response.json({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 }));
    expect(result.metadata?.projectId).toBe("same-project");
    expect(result.refresh).toBe("new-refresh");
    expect(result.access).toBe("new");
  });

  test("rejects foreign callbacks and accepts a valid loopback callback", async () => {
    const port = await unusedPort();
    let count = 0;
    const redirectURI = `http://localhost:${port}/oauth-callback`;
    const attempt = await startLoopbackAuthorization({ redirectURI, timeoutMs: 5000, fetcher: async () => ++count === 1
      ? Response.json({ access_token: "fake", refresh_token: "fake-refresh", expires_in: 3600 })
      : Response.json({ cloudaicompanionProject: "project" }) });
    const state = new URL(attempt.url).searchParams.get("state");
    const wrong = await fetch(`http://127.0.0.1:${port}/oauth-callback?state=wrong&code=test`);
    expect(wrong.status).toBe(400);
    const valid = await fetch(`http://127.0.0.1:${port}/oauth-callback?state=${state}&code=test`);
    expect(valid.status).toBe(200);
    expect((await attempt.callback).metadata?.projectId).toBe("project");
  });

  test("cleans up the listener after cancellation", async () => {
    const port = await unusedPort();
    const redirectURI = `http://localhost:${port}/oauth-callback`;
    const attempt = await startLoopbackAuthorization({ redirectURI });
    attempt.cancel();
    await expect(attempt.callback).rejects.toThrow("canceled");
    const next = await startLoopbackAuthorization({ redirectURI, timeoutMs: 20 });
    await expect(next.callback).rejects.toThrow("timed out");
  });

  test("canceling after the browser callback aborts the project lookup", async () => {
    const port = await unusedPort();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let count = 0;
    const attempt = await startLoopbackAuthorization({
      redirectURI: `http://localhost:${port}/oauth-callback`,
      fetcher: async (_input, init) => {
        if (++count === 1) return Response.json({ access_token: "fake", refresh_token: "fake-refresh", expires_in: 3600 });
        return new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) throw new Error("Missing cancellation signal.");
          init.signal.addEventListener("abort", () => reject(new Error("Lookup canceled.")), { once: true });
          resolveStarted();
        });
      },
    });
    const state = new URL(attempt.url).searchParams.get("state");
    await fetch(`http://127.0.0.1:${port}/oauth-callback?state=${state}&code=test`);
    await started;
    attempt.cancel();
    await expect(attempt.callback).rejects.toThrow("Lookup canceled");
    expect(count).toBe(2);
  });
});
