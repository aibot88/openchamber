import { describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, Agent } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createSubscriptionHTTP, proxyFor, wireHeaders } from "../subscription-http.ts";
import { SUBSCRIPTION_ENDPOINT, USER_AGENT } from "../constants.ts";

function request(action = "streamGenerateContent") {
  return new Request(`${SUBSCRIPTION_ENDPOINT}/v1internal:${action}${action === "streamGenerateContent" ? "?alt=sse" : ""}`, {
    method: "POST", headers: { Authorization: "Bearer fixture", "x-goog-api-key": "must-not-send" }, body: '{"text":"记忆"}',
  });
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const agent = new Agent({ keepAlive: true });
  // The exact HTTP/1.1 sender and parser run against a local fixture. The
  // production URL guard remains active; no TLS trust setting is overridden.
  const http = createSubscriptionHTTP({ env: {}, request: ((url: URL, options: object, callback: unknown) =>
    httpRequest(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...options, agent }, callback as (response: IncomingMessage) => void)) as typeof httpsRequest });
  return { http, async close() { http.dispose(); agent.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

describe("subscription HTTP/1.1 sender", () => {
  test("uses the captured ordered headers, chunked streaming and UTF-8 byte length", () => {
    const bytes = new TextEncoder().encode('{"text":"记忆"}');
    expect(wireHeaders(request(), bytes)).toEqual([
      "Host", "daily-cloudcode-pa.googleapis.com", "User-Agent", USER_AGENT,
      "Transfer-Encoding", "chunked", "Authorization", "Bearer fixture", "Content-Type", "application/json", "Accept-Encoding", "gzip",
    ]);
    expect(wireHeaders(request("generateContent"), bytes).slice(4, 6)).toEqual(["Content-Length", String(bytes.byteLength)]);
  });

  test("actually sends ordered HTTP/1.1 framing and decodes gzip without buffering the full response", async () => {
    let headers: string[] = [];
    let body = "";
    const wire = await fixture((incoming, outgoing) => {
      headers = incoming.rawHeaders;
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { body += chunk; });
      incoming.on("end", () => {
        outgoing.writeHead(200, { "Content-Type": "text/event-stream", "Content-Encoding": "gzip" });
        outgoing.end(gzipSync('data: {"response":{"text":"记忆"}}\n\n'));
      });
    });
    try {
      const response = await wire.http.fetch(request());
      expect(await response.text()).toBe('data: {"response":{"text":"记忆"}}\n\n');
      expect(headers).toEqual(wireHeaders(request(), new TextEncoder().encode(body)));
      expect(body).toBe('{"text":"记忆"}');
      expect(response.headers.has("content-encoding")).toBe(false);
    } finally { await wire.close(); }
  });

  test("does not follow redirects or resubmit Google errors", async () => {
    let calls = 0;
    const wire = await fixture((incoming, outgoing) => {
      calls++; incoming.resume(); outgoing.writeHead(302, { Location: "https://attacker.invalid/steal" }); outgoing.end("redirect");
    });
    try {
      const response = await wire.http.fetch(request());
      expect(response.status).toBe(302);
      expect(await response.text()).toBe("redirect");
      expect(calls).toBe(1);
    } finally { await wire.close(); }
  });

  test("rejects production, paid APIs, custom hosts, redirects and unknown RPCs before network work", async () => {
    let sends = 0;
    const http = createSubscriptionHTTP({ request: (() => { sends++; throw new Error("must not send"); }) as typeof httpsRequest });
    try {
      for (const url of [
        "https://cloudcode-pa.googleapis.com/v1internal:generateContent", "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
        `${SUBSCRIPTION_ENDPOINT}/v1internal:unknown`, `${SUBSCRIPTION_ENDPOINT}/v1internal:generateContent?url=foreign`,
      ]) await expect(http.fetch(new Request(url, { method: "POST", headers: { Authorization: "Bearer fixture" }, body: "{}" }))).rejects.toThrow("No endpoint or API fallback");
      expect(sends).toBe(0);
    } finally { http.dispose(); }
  });

  test("rejects unsupported proxies instead of silently bypassing the user's network route", () => {
    expect(proxyFor("google.invalid", { HTTPS_PROXY: "http://proxy.invalid:8080" })?.host).toBe("proxy.invalid:8080");
    expect(proxyFor("google.invalid", { HTTPS_PROXY: "http://proxy.invalid:8080", NO_PROXY: ".invalid" })).toBeUndefined();
    expect(() => proxyFor("google.invalid", { ALL_PROXY: "socks5://proxy.invalid:1080" })).toThrow("no direct-network fallback");
  });
});
