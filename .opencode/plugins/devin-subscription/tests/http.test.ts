import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { request as httpRequest, Agent } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createHTTP, proxyFor, validateDestination } from "../http.ts";
import { CATALOG_PATH, CHAT_PATH, ORIGIN } from "../constants.ts";

const token = "devin-session-token$fixture-http-offline-only";
const request = (path = CHAT_PATH, signal?: AbortSignal) => new Request(ORIGIN + path, { method: "POST", body: "fixture", signal, headers: { Authorization: `Basic ${token}-${token}` } });

test.each(["https://evil.invalid" + CHAT_PATH, ORIGIN + "/v1/chat/completions", ORIGIN + CHAT_PATH + "?redirect=evil", "https://user:password@server.codeium.com" + CHAT_PATH])( "transport rejects any unapproved destination", (url) => {
  expect(() => validateDestination(new Request(url, { method: "POST", headers: { Authorization: `Basic ${token}-${token}` } }))).toThrow("destination");
});
test("authentication is exactly the current session-token pair", () => {
  expect(validateDestination(request()).pathname).toBe(CHAT_PATH);
  expect(() => validateDestination(new Request(ORIGIN + CHAT_PATH, { method: "POST", headers: { Authorization: `Bearer ${token}` } }))).toThrow("authentication");
  expect(() => validateDestination(new Request(ORIGIN + CHAT_PATH, { method: "POST", headers: { Authorization: `Basic ${token}-${token}2` } }))).toThrow("authentication");
});
test("proxy exclusions, HTTP(S) CONNECT and unsupported-scheme refusal", () => {
  expect(proxyFor({ HTTPS_PROXY: "http://localhost:7890" })?.protocol).toBe("http:");
  expect(proxyFor({ HTTPS_PROXY: "https://localhost:7890" })?.protocol).toBe("https:");
  expect(proxyFor({ HTTP_PROXY: "http://localhost:7890" })?.protocol).toBe("http:");
  expect(proxyFor({ HTTPS_PROXY: "http://localhost:7890", NO_PROXY: ".codeium.com" })).toBeUndefined();
  expect(() => proxyFor({ HTTPS_PROXY: "socks5://localhost:7890" })).toThrow("No direct-network");
  expect(() => proxyFor({ HTTPS_PROXY: "not-a-url" })).toThrow("configuration");
});

test("the Node sender really sends HTTP/1.1, Connect headers and decodes HTTP gzip", async () => {
  const observed: { version: string; authorization?: string; type?: string; body: string }[] = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    observed.push({ version: incoming.httpVersion, authorization: incoming.headers.authorization, type: incoming.headers["content-type"], body: Buffer.concat(chunks).toString() });
    outgoing.writeHead(200, { "Content-Type": "application/proto", "Content-Encoding": "gzip" }); outgoing.end(gzipSync("fixture-response"));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const agent = new Agent();
  let alpn: string[] | undefined;
  const transport = createHTTP({ env: {}, request: (_url, options, callback) => {
    alpn = options.ALPNProtocols;
    return httpRequest(origin, { ...options, agent }, callback);
  } });
  try {
    expect(await (await transport.send(request(CATALOG_PATH))).text()).toBe("fixture-response");
    expect(await (await transport.send(request(CHAT_PATH))).text()).toBe("fixture-response");
    expect(alpn).toEqual(["http/1.1"]); expect(observed.map((item) => item.version)).toEqual(["1.1", "1.1"]);
    expect(observed.map((item) => item.type)).toEqual(["application/proto", "application/connect+proto"]);
    expect(observed[0].authorization).toBe(`Basic ${token}-${token}`); expect(observed[0].body).toBe("fixture");
  } finally { transport.dispose(); agent.destroy(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test("pre-dispatch abort and invalid destination never invoke the sender", async () => {
  let sends = 0;
  const transport = createHTTP({ env: {}, request: () => { sends++; throw new Error("should-not-send"); } });
  const controller = new AbortController(); controller.abort();
  try {
    await expect(transport.send(request(CHAT_PATH, controller.signal))).rejects.toThrow();
    await expect(transport.send(request("/invalid"))).rejects.toThrow("destination"); expect(sends).toBe(0);
  } finally { transport.dispose(); }
  await expect(transport.send(request())).rejects.toThrow("closed");
});
test("network failures are redacted and are not retried", async () => {
  const server = createServer((incoming) => incoming.socket.destroy()); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let sends = 0;
  const transport = createHTTP({ env: {}, request: (_url, options, callback) => { sends++; return httpRequest(origin, options, callback); } });
  try { await expect(transport.send(request())).rejects.toThrow("No fallback"); expect(sends).toBe(1); }
  finally { transport.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test.each(["headers", "idle", "total", "signal", "dispose", "body-cancel"] as const)("%s stops the active HTTP request without retry", async (reason) => {
  let ticker: ReturnType<typeof setInterval> | undefined;
  let sends = 0;
  const server = createServer((_incoming, outgoing) => {
    if (reason === "headers") return;
    outgoing.writeHead(200, { "Content-Type": "application/connect+proto" });
    outgoing.write("fixture-partial");
    if (reason === "total") ticker = setInterval(() => outgoing.write("."), 5);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback test listener.");
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = createHTTP({ env: {}, headerMs: 30, idleMs: 30, totalMs: 60,
    request: (_url, options, callback) => { sends++; return httpRequest(origin, options, callback); } });
  const controller = new AbortController();
  try {
    if (reason === "headers") await expect(transport.send(request(CHAT_PATH, controller.signal))).rejects.toThrow("No fallback");
    else {
      const response = await transport.send(request(CHAT_PATH, controller.signal));
      if (reason === "body-cancel") await response.body!.cancel();
      else {
        const text = response.text();
        if (reason === "signal") controller.abort();
        if (reason === "dispose") transport.dispose();
        await expect(text).rejects.toThrow("response body failed");
      }
    }
    expect(sends).toBe(1);
  } finally {
    clearInterval(ticker); transport.dispose(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("malformed proxy credentials fail before sending and are never included in errors", async () => {
  let sends = 0;
  const transport = createHTTP({ env: { HTTPS_PROXY: "http://synthetic%zz:synthetic-secret@127.0.0.1:1" }, request: () => { sends++; throw new Error("must not send"); } });
  try {
    await expect(transport.send(request())).rejects.toThrow("Invalid Devin proxy credentials.");
    expect(sends).toBe(0);
  } finally { transport.dispose(); }
});
