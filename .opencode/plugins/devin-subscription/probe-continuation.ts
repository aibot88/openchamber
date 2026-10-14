// Real OpenCode 2 loop, isolated credentials/tools, loopback-only model fixtures.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { bytes, fields, integer, message, number, string, text } from "./protobuf.ts";
import { envelope } from "./connect.ts";
import { CATALOG_PATH, CHAT_PATH } from "./constants.ts";
import { STORAGE_KEY } from "./desktop-import.ts";

const binary = process.env.OPENCODE_BIN ?? (process.platform === "darwin" ? "/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode" : "opencode");
const reported = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
const version = reported.match(/^(?:opencode v)?(2\.\d+\.\d+(?:[-+][\w.-]+)?)$/)?.[1];
if (!version) throw new Error("This probe requires OpenCode 2. Set OPENCODE_BIN.");
const root = await mkdtemp(join(process.env.PROBE_TMPDIR ?? tmpdir(), "devin-continuation-"));
const bundled = process.env.DEVIN_PROBE_BUNDLE === "1";
const browser = process.env.DEVIN_PROBE_BROWSER === "1";
const desktopApp = process.env.DEVIN_PROBE_DESKTOP_APP;
const desktopScenario = process.env.DEVIN_PROBE_DESKTOP_SCENARIO;
if (desktopApp && !browser) throw new Error("Desktop acceptance requires browser fixture mode.");
if (desktopScenario && !desktopApp) throw new Error("Desktop scenario requires an isolated packaged app.");
let setupModule = fileURLToPath(new URL("./index.ts", import.meta.url));
if (bundled) {
  // Load a copied artifact outside the checkout in a fresh Bun process with no
  // NODE_PATH or development dependencies. Importing does not run plugin setup.
  const copied = join(root, "standalone-provider");
  await cp(fileURLToPath(new URL("./dist", import.meta.url)), copied, { recursive: true });
  setupModule = join(copied, "index.js");
  const env = { HOME: root, PATH: process.env.PATH ?? "" };
  execFileSync(process.execPath, ["--eval", `const plugin = await import(${JSON.stringify(pathToFileURL(setupModule).href)});
    if (plugin.default.id !== 'opencode.provider.devin-subscription' || typeof plugin.setup !== 'function') throw new Error('Invalid standalone bundle');`],
    { cwd: root, env, timeout: 10_000, stdio: "pipe" });
  const importer = spawnSync(process.execPath, [join(copied, "import-command.js"), "--not-an-auth-attempt"], { cwd: root, env, timeout: 10_000, encoding: "utf8" });
  if (importer.error || importer.status !== 1 || importer.stdout || !importer.stderr.includes("connection method")) throw new Error("Standalone importer did not refuse direct invocation safely.");
}
const project = join(root, "project"), plugin = join(root, "fixture-plugin");
await mkdir(project); await mkdir(plugin); await writeFile(join(project, "memory.txt"), "A-TOOL-MARKER-6432");
const storage = join(root, "Library/Application Support/Devin/User/globalStorage");
await mkdir(storage, { recursive: true });
const syntheticRecord = (token: string) => {
  const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync("synthetic-keychain", "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 32));
  return JSON.stringify(Buffer.concat([Buffer.from("v10"), cipher.update(JSON.stringify([{ accessToken: token }])), cipher.final()]));
};
const { Database } = await import("bun:sqlite");
const db = new Database(join(storage, "state.vscdb")); db.run("CREATE TABLE ItemTable(key TEXT UNIQUE,value TEXT)");
db.query("INSERT INTO ItemTable VALUES (?,?)").run(STORAGE_KEY, syntheticRecord("devin-session-token$fixture-offline-only")); db.close();
const importFixture = join(plugin, "import-fixture.ts");
const importerModule = bundled ? join(root, "standalone-provider", "import-command.js") : fileURLToPath(new URL("./desktop-import.ts", import.meta.url));
await writeFile(importFixture, `import { importDesktopLogin } from ${JSON.stringify(importerModule)};
process.stdout.write(await importDesktopLogin({ platform: 'darwin', home: ${JSON.stringify(root)}, readPassword: async () => 'synthetic-keychain' }));`);
const confirmSchema = z.toJSONSchema(z.object({ limit: z.number().int().positive(), description: z.string(), title: z.string() }));
const confirmArgs = { limit: 1, description: "argument-data", title: "argument-data" };
const googleRequest = z.object({ contents: z.array(z.json()), tools: z.array(z.object({ functionDeclarations: z.array(z.object({ name: z.string() })).optional() })).optional() });
const firstToken = "devin-session-token$fixture-offline-only";
const secondToken = "devin-session-token$fixture-second-account-only";
const refusedToken = "devin-session-token$fixture-catalog-refused";
let phase = "A-first";
let requests = 0, declarations = 0, catalogReads = 0;
const unknownLimits = process.env.DEVIN_PROBE_UNKNOWN_LIMITS === "1";
const tools: string[] = [], routes: string[] = [];
const upstreamSessions = new Set<string>();
const audits: { phase: string; native?: string; payload?: z.infer<typeof googleRequest> }[] = [];
const driverInputs: z.infer<ReturnType<typeof z.json>>[] = [];
let fixtureError: string | undefined;
let commandStarts = 0, commandCancels = 0;
const commandOutcomeSchema = z.enum(["wait", "fail", "succeed"]);
const fixtureAccountSchema = z.enum(["first", "second"]);
let commandOutcome: z.infer<typeof commandOutcomeSchema> = "wait";
const fixtures = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  try {
    const path = new URL(request.url).pathname;
    if (browser && path === "/command-start") { commandStarts++; return new Response("ok"); }
    if (browser && path === "/command-cancel") { commandCancels++; return new Response("ok"); }
    if (browser && path === "/command-control") {
      if (request.method === "POST") commandOutcome = commandOutcomeSchema.parse(await request.json());
      return Response.json(commandOutcome);
    }
    if (browser && path === "/command-account" && request.method === "POST") {
      const account = fixtureAccountSchema.parse(await request.json());
      const fixtureDB = new Database(join(storage, "state.vscdb"));
      try {
        fixtureDB.query("UPDATE ItemTable SET value = ? WHERE key = ?").run(syntheticRecord(account === "first" ? firstToken : secondToken), STORAGE_KEY);
      } finally { fixtureDB.close(); }
      return new Response("ok");
    }
    if (browser && path === "/probe-status") return Response.json({ commandStarts, catalogReads, tools, routes,
      commandCancels, commandOutcome, upstreamSessionCount: upstreamSessions.size, declarations,
      phases: audits.map((audit) => audit.phase), catalogLimitsUnknown: unknownLimits,
      fixtureError, realDevinRequests: 0, realCredentialOrKeychainReads: 0 });
    if (path === "/driver-input") { driverInputs.push(z.json().parse(await request.json())); return new Response("ok"); }
    if (path.startsWith("/tool/")) { tools.push(path.slice(6)); return new Response("ok"); }
    if (++requests > (browser ? 1000 : 25)) throw new Error("Fixture request limit reached.");
    const upstream = request.headers.get("x-fixture-upstream");
    if (!upstream) {
      const input = googleRequest.parse(await request.json());
      const history = JSON.stringify(input.contents);
      if (browser) phase = history.includes("DEVIN-CONFIRMED-6432") ? "A-back" : "A-first";
      audits.push({ phase, payload: input });
      const name = input.tools?.flatMap((tool) => tool.functionDeclarations ?? []).find((tool) => tool.name.endsWith("execute"))?.name;
      const parts = phase === "A-first" && !history.includes("A-TOOL-MARKER-6432")
        ? [{ functionCall: { id: "A-read-call", name: name ?? "execute", args: { code: "return await tools.fixture_read();" } } }]
        : [{ text: `Fixture ${phase} retained tool results.` }];
      if (phase === "A-back" && !history.includes("DEVIN-CONFIRMED-6432")) throw new Error("A lost Devin's tool result.");
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112 } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    const raw = Buffer.from(await request.arrayBuffer());
    const upstreamPath = new URL(upstream).pathname;
    const auth = request.headers.get("authorization");
    const fixtureToken = [firstToken, secondToken, refusedToken].find((token) => auth === `Basic ${token}-${token}`);
    if (!fixtureToken) throw new Error("Incorrect synthetic Basic header.");
    if (upstreamPath === CATALOG_PATH) {
      catalogReads++;
      if (fixtureToken === refusedToken) return new Response("Synthetic catalog refusal", { status: 401 });
      const meta = fields(message(fields(raw), 1)!);
      if (string(meta, 1) !== "chisel" || string(meta, 3) !== fixtureToken) throw new Error("Incorrect synthetic catalog metadata.");
      const selectors = fixtureToken === firstToken ? ["fixture-model-1", "fixture-model-2"] : ["fixture-model-3"];
      const catalog = selectors.map((selector) => bytes(1, Buffer.concat([text(1, selector), text(22, selector),
        ...(unknownLimits ? [] : [integer(18, selector === "fixture-model-1" ? 1_000_000 : 200_000)]),
        bytes(23, Buffer.concat([text(23, "alias-not-a-route"), ...(unknownLimits ? [] : [integer(13, selector === "fixture-model-1" ? 128_000 : 32_768)])]))])));
      return new Response(gzipSync(Buffer.concat(catalog)), { headers: { "Content-Type": "application/proto", "Content-Encoding": "gzip" } });
    }
    if (upstreamPath !== CHAT_PATH || raw[0] !== 1 || raw.readUInt32BE(1) !== raw.length - 5) throw new Error("Incorrect Connect request framing.");
    const native = fields(gunzipSync(raw.subarray(5)));
    const completion = fields(message(native, 8)!);
    if (number(completion, 3) !== undefined) throw new Error("A context limit occupied the newline field.");
    const dump = Buffer.concat(native.filter((field) => field.wire === 2).map((field) => { if (field.wire !== 2) throw new Error(); return field.value; })).toString("utf8");
    if (!dump.includes("A-TOOL-MARKER-6432")) throw new Error("Devin lost A's prior tool result.");
    const selector = string(native, 21)!;
    if (number(completion, 2) !== (selector === "fixture-model-1" ? 65_536 : 16_384)) throw new Error("The selected model's explicit output budget was changed.");
    if (browser) phase = selector === "fixture-model-1" ? "Devin-1" : "Devin-2";
    audits.push({ phase, native: dump });
    routes.push(selector); upstreamSessions.add(string(native, 16)!);
    if (selector !== (phase === "Devin-1" ? "fixture-model-1" : "fixture-model-2")) throw new Error("Model selector was substituted.");
    const definitions = native.filter((field) => field.tag === 10).map((field) => { if (field.wire !== 2) throw new Error(); return fields(field.value); });
    declarations += definitions.length;
    const confirm = definitions.find((fn) => string(fn, 1)?.endsWith("fixture_confirm"));
    if (!confirm || !string(confirm, 2)?.includes("Isolated fixture tool")) throw new Error("Tool description was neutralized.");
    const schema = z.object({ properties: z.object({ limit: z.object({ exclusiveMinimum: z.literal(0) }) }) }).parse(JSON.parse(string(confirm, 3)!));
    if (schema.properties.limit.exclusiveMinimum !== 0) throw new Error("Native JSON Schema was altered.");
    const chunks: Buffer[] = [];
    if (phase === "Devin-2" && !dump.includes("DEVIN-CONFIRMED-6432")) {
      chunks.push(envelope(bytes(6, Buffer.concat([text(1, "devin-confirm-call"), text(2, string(confirm, 1)!), text(3, '{"limit":1,')]))));
      chunks.push(envelope(bytes(6, text(3, '"description":"argument-data","title":"argument-data"}')), 1));
    } else {
      if (phase === "Devin-2") {
        const result = native.filter((field) => field.tag === 3).map((field) => { if (field.wire !== 2) throw new Error(); return fields(field.value); }).find((turn) => string(turn, 7) === "devin-confirm-call");
        if (!result || number(result, 2) !== 4 || !string(result, 3)?.includes("DEVIN-CONFIRMED-6432")) throw new Error("Native tool-result ID/role did not survive the agent loop.");
      }
      chunks.push(envelope(Buffer.concat([text(3, `Fixture ${phase} retained tool results.`), text(9, "Synthetic reasoning.")]), 1));
    }
    chunks.push(envelope(Buffer.concat([integer(5, 2), bytes(7, Buffer.concat([integer(2, 100), integer(3, 12)]))])), envelope(Buffer.from("{}"), 3));
    return new Response(gzipSync(Buffer.concat(chunks)), { headers: { "Content-Type": "application/connect+proto", "Content-Encoding": "gzip" } });
  } catch (error) {
    fixtureError = error instanceof Error ? error.message : "Fixture failed";
    return new Response("Offline fixture validation failed", { status: 400 });
  }
} });
const origin = `http://127.0.0.1:${fixtures.port}`;
if (browser) await writeFile(importFixture, `import { importDesktopLogin } from ${JSON.stringify(importerModule)};
process.once('SIGTERM', async () => {
  await fetch(${JSON.stringify(origin + "/command-cancel")}, { method: 'POST' });
  process.exit(1);
});
await fetch(${JSON.stringify(origin + "/command-start")}, { method: 'POST' });
for (;;) {
  const outcome = await (await fetch(${JSON.stringify(origin + "/command-control")})).json();
  if (outcome === 'fail') throw new Error('Synthetic import failure. No real storage or Keychain was accessed.');
  if (outcome === 'succeed') break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
process.stdout.write(await importDesktopLogin({ platform: 'darwin', home: ${JSON.stringify(root)}, readPassword: async () => 'synthetic-keychain' }));`);
await writeFile(join(plugin, "package.json"), JSON.stringify({ type: "module", main: "index.ts" }));
await writeFile(join(plugin, "index.ts"), `
import { Plugin, Model, Provider } from '@opencode/plugin';
import { readFile } from 'node:fs/promises';
import { request as httpRequest, Agent } from 'node:http';
import { setup } from ${JSON.stringify(setupModule)};
import { createHTTP } from ${JSON.stringify(fileURLToPath(new URL("./http.ts", import.meta.url)))};
export default Plugin.define({ id: 'fixture.devin-continuation', async setup(ctx) {
  await ctx.provider.transform(editor => editor.add({ info: {
    ...Provider.Info.empty(Provider.ID.make('offline-a')), name: 'Offline A', activation: 'enabled',
    package: '@opencode/ai/providers/google', settings: { apiKey: 'fixture', baseURL: '${origin}/v1beta' },
  }, models: [Model.Info.default(Provider.ID.make('offline-a'), Model.ID.make('gemini-3.1-pro'))] }));
  await ctx.session.hook('title', event => { event.result = 'Offline Devin continuation'; });
  await ctx.session.hook('context', event => {
    event.options.maxTokens = event.model.id === 'fixture-model-1' ? 65536 : 16384;
  }, { providerID: 'devin-subscription' });
  await ctx.tool.transform(editor => {
    for (const name of ['fixture_read','fixture_confirm']) editor.add({ name, description: 'Isolated fixture tool; preserve description',
      input: name === 'fixture_confirm' ? ${JSON.stringify(confirmSchema)} : { type: 'object', properties: {}, additionalProperties: false },
      options: { codemode: name === 'fixture_read' }, async execute(input) {
        const expected = ${JSON.stringify(confirmArgs)};
        if (name === 'fixture_confirm' && (Object.keys(input).length !== Object.keys(expected).length || Object.entries(expected).some(([key,value]) => input[key] !== value))) throw new Error('Tool arguments changed.');
        await fetch('${origin}/tool/' + name, { method: 'POST' });
        return { content: name === 'fixture_read' ? await readFile(${JSON.stringify(join(project, "memory.txt"))},'utf8') : 'DEVIN-CONFIRMED-6432' };
      }
    });
  });
  const agent = new Agent();
  await ctx.session.hook('http.request', async event => {
    await fetch('${origin}/driver-input', { method: 'POST', body: await event.request.clone().text() });
  }, { providerID: Provider.ID.make('devin-subscription') });
  const wire = createHTTP({ env: {}, request: (url,options,callback) => httpRequest('${origin}/devin-fixture',
    { ...options, agent, headers: { ...options.headers, 'x-fixture-upstream': url.toString() } }, callback) });
  const dispose = await setup(ctx, { send: wire.send, bridgeEnv: {} });
  await ctx.integration.transform(editor => editor.method.update({ integrationID: 'devin-subscription', method: {
    type: 'command', id: 'devin-desktop-import', label: 'Import local Devin Desktop login (offline synthetic fixture; no Keychain access)', command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(importFixture)}],
  } }));
  return async () => { wire.dispose(); agent.destroy(); await dispose(); };
} });
`);
await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [plugin], model: "offline-a/gemini-3.1-pro", agents: { build: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } } }));
const password = randomBytes(32).toString("base64url");
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|GOOGLE_|GEMINI_|DEVIN_|WINDSURF_|OPENAI_|ANTHROPIC_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)/.test(key) && !/(?:API_KEY|TOKEN|PASSWORD|SECRET)$/.test(key))),
    HOME: root, XDG_CONFIG_HOME: join(root,"config"), XDG_DATA_HOME: join(root,"data"), XDG_STATE_HOME: join(root,"state"), XDG_CACHE_HOME: join(root,"cache"),
    OPENCODE_DB: ":memory:", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password }, stdio: ["ignore","pipe","pipe"] });
let output = "";
const ready = new Promise<string>((resolve,reject) => {
  const collect = (chunk: Buffer) => { output += chunk.toString(); const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); };
  child.stdout.on("data",collect); child.stderr.on("data",collect); child.once("error",reject);
  child.once("exit",code => reject(new Error(`Offline runtime exited (${code}): ${output.slice(-2500)}`)));
});
const deadline = setTimeout(() => child.kill("SIGTERM"), browser ? 20 * 60_000 : 90_000);
let web: ReturnType<typeof spawn> | undefined;
try {
  const baseUrl = await ready;
  const client = OpenCode.make({ baseUrl, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(project) } });
  const controller = new AbortController(); const iterator = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
  await iterator.next(); await client.location.reload();
  for (;;) {
    const integrations = await client.integration.list();
    const registered = integrations.data.find((item) => item.id === "devin-subscription" && item.methods.some((method) => method.type === "key"));
    if (registered) {
      if (registered.name !== "Devin subscription (unofficial)") throw new Error("Unconnected Devin integration has lost its human-readable risk label.");
      break;
    }
    const plugins = await client.plugin.list(); const failed = plugins.data.find((item) => item.state.status === "failed");
    if (failed) throw new Error(`Offline plugin failed: ${JSON.stringify(failed)}`);
    if ((await iterator.next()).done) throw new Error("Fixture plugin did not register.");
  }
  if ((await client.model.list()).data.some((model) => model.providerID === "devin-subscription")) throw new Error("Models were exposed before an account's catalog was loaded.");
  if (browser) {
    controller.abort();
    const repository = fileURLToPath(new URL("../../../", import.meta.url));
    const webPackage = process.env.DEVIN_PROBE_WEB_PACKAGE ?? join(repository, "packages/web");
    const data = join(root, "openchamber-data");
    await mkdir(data);
    const id = `path_${Buffer.from(project).toString("base64url")}`;
    await writeFile(join(data, "settings.json"), JSON.stringify({ homeDirectory: root, lastDirectory: project,
      projects: [{ id, path: project, label: "Offline Devin acceptance", addedAt: Date.now(), lastOpenedAt: Date.now() }],
      activeProjectId: id, defaultModel: "offline-a/gemini-3.1-pro", usageTracking: false }));
    // A fresh origin keeps a previous fixture's browser directory state out of
    // this temporary HOME. Reserve first so an occupied explicit port fails.
    const requestedPort = process.env.DEVIN_PROBE_UI_PORT === undefined ? 0 : Number(process.env.DEVIN_PROBE_UI_PORT);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535 || (requestedPort > 0 && requestedPort < 1024)) throw new Error("Invalid browser probe port.");
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: requestedPort, fetch: () => new Response("Starting isolated fixture", { status: 503 }) });
    const port = reservation.port;
    await reservation.stop(true);
    web = spawn(desktopApp ? join(desktopApp, "Contents/MacOS/OpenChamber") : process.execPath,
      desktopApp ? ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`] : [join(webPackage, "server/index.js"), "--port", String(port), "--host", "127.0.0.1"], {
      cwd: project, env: { HOME: root, USERPROFILE: root, SHELL: "/bin/zsh", PATH: process.env.PATH ?? "", TMPDIR: process.env.PROBE_TMPDIR ?? tmpdir(),
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_DIST_DIR: join(webPackage, "dist"), OPENCHAMBER_RELAY_HOST: "off",
        OPENCHAMBER_DESKTOP_USER_DATA_DIR: join(root, "electron-profile"),
        OPENCODE_HOST: baseUrl, OPENCODE_SKIP_START: "true", OPENCODE_PASSWORD: password, OPENCODE_BINARY: binary }, stdio: ["ignore", "pipe", "pipe"] });
    let webOutput = "";
    const log = (chunk: Buffer) => { webOutput += chunk.toString(); };
    web.stdout?.on("data", log); web.stderr?.on("data", log);
    const url = `http://127.0.0.1:${port}`;
    const until = Date.now() + 30_000;
    let served = "";
    while (Date.now() < until && web.exitCode === null) {
      try { const response = await fetch(url + (desktopApp ? "/json/list" : ""), { signal: AbortSignal.timeout(1000) }); if (response.ok) { served = await response.text(); break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!(desktopApp ? served.includes("webSocketDebuggerUrl") : served.includes("/assets/main-"))) throw new Error(`Built OpenChamber UI did not start: ${webOutput.slice(-2000)}`);
    console.log(JSON.stringify({ browserProbe: true, url, desktopApp, desktopPID: desktopApp ? web.pid : undefined, fixtureStatusURL: origin + "/probe-status", fixtureDirectory: root, pid: process.pid,
      noAutomaticAuthentication: commandStarts === 0, providerBundle: bundled, realDevinRequests: 0, realCredentialOrKeychainReads: 0 }, null, 2));
    if (desktopScenario) {
      const scenario = spawn(process.execPath, [desktopScenario], { cwd: project,
        env: { HOME: root, PATH: process.env.PATH ?? "", DEVIN_DESKTOP_DEBUG_URL: url, DEVIN_DESKTOP_FIXTURE_STATUS_URL: origin + "/probe-status" }, stdio: "inherit" });
      await new Promise<void>((resolve, reject) => {
        scenario.once("error", reject);
        scenario.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Synthetic desktop scenario exited ${code}.`)));
      });
    } else {
      await new Promise<void>((resolve) => {
        process.once("SIGTERM", resolve); process.once("SIGINT", resolve); child.once("exit", () => resolve()); web?.once("exit", () => resolve());
      });
    }
    await writeFile(join(root, "browser-report.json"), JSON.stringify({ opencode: version, webPackage, desktopApp, providerBundle: bundled,
      commandStarts, commandCancels, catalogReads, tools, routes, phases: audits.map((audit) => audit.phase),
      upstreamSessionCount: upstreamSessions.size, declarations, fixtureError, realDevinRequests: 0, realCredentialOrKeychainReads: 0 }, null, 2));
  } else {
  const command = await client.integration.command.connect({ integrationID: "devin-subscription", methodID: "devin-desktop-import", label: "Synthetic fixture only" });
  for (;;) {
    const models = await client.model.list();
    if (models.data.some((item) => item.providerID === "devin-subscription" && item.id === "fixture-model-2")) break;
    if ((await iterator.next()).done) throw new Error("Synthetic catalog did not register.");
  }
  const commandStatus = await client.integration.command.status({ integrationID: "devin-subscription", attemptID: command.data.attemptID });
  if (commandStatus.data.status !== "complete" || JSON.stringify(commandStatus).includes("devin-session-token$")) throw new Error("Command authentication did not complete safely.");
  controller.abort();
  const reportedModels = (await client.model.list()).data.filter((model) => model.providerID === "devin-subscription");
  if (reportedModels.find((model) => model.id === "fixture-model-1")?.limit.context !== (unknownLimits ? 0 : 1_000_000) ||
      reportedModels.find((model) => model.id === "fixture-model-1")?.limit.output !== (unknownLimits ? 0 : 128_000) ||
      reportedModels.find((model) => model.id === "fixture-model-2")?.limit.output !== (unknownLimits ? 0 : 32_768)) throw new Error("The host lost per-model catalog limits.");
  const session = await client.session.create({ title: "Offline Devin tool continuation" });
  for (const step of [{ phase:"A-first",providerID:"offline-a",id:"gemini-3.1-pro" },{ phase:"Devin-1",providerID:"devin-subscription",id:"fixture-model-1" },
    { phase:"Devin-2",providerID:"devin-subscription",id:"fixture-model-2" },{ phase:"A-back",providerID:"offline-a",id:"gemini-3.1-pro" }]) {
    phase = step.phase;
    await client.session.switchModel({ sessionID: session.id, model: { providerID:step.providerID,id:step.id } });
    await client.session.prompt({ sessionID:session.id,text:"Continue this tool fixture without repeating earlier tools." }); await client.session.wait({ sessionID:session.id });
    const context = await client.session.context({ sessionID:session.id });
    const assistant = [...context].reverse().find((item) => item.type === "assistant");
    if (fixtureError || !audits.some((audit) => audit.phase === phase) || !assistant || assistant.type !== "assistant" || assistant.model.providerID !== step.providerID || assistant.model.id !== step.id || assistant.error || assistant.finish === "error") throw new Error(`Agent loop failed: ${fixtureError ?? JSON.stringify(context.slice(-3))}`);
  }
  const context = JSON.stringify(await client.session.context({ sessionID:session.id }));
  if (!context.includes("A-TOOL-MARKER-6432") || !context.includes("DEVIN-CONFIRMED-6432")) throw new Error("Persisted context lost a tool result.");
  if (JSON.stringify(tools) !== JSON.stringify(["fixture_read","fixture_confirm"])) throw new Error("Tools were repeated or skipped.");
  if (upstreamSessions.size !== 1 || !declarations || routes.length !== 3) throw new Error("Native routing or tool declaration probe did not execute.");
  // These are credentials created only in this isolated fixture runtime. Check
  // actual registry refreshes on account selection and a new account's refusal.
  const catalogEvents = new AbortController();
  const changed = client.event.subscribe({ signal: catalogEvents.signal })[Symbol.asyncIterator]();
  await changed.next();
  const waitInventory = async (expected: string[]) => {
    for (;;) {
      const actual = (await client.model.list()).data.filter((model) => model.providerID === "devin-subscription").map((model) => model.id).sort();
      if (JSON.stringify(actual) === JSON.stringify(expected)) return;
      if ((await changed.next()).done) throw new Error("Catalog switch did not finish.");
    }
  };
  try {
    const original = (await client.credential.list()).find((entry) => entry.integrationID === "devin-subscription" && entry.active);
    if (!original) throw new Error("Missing synthetic original credential.");
    await client.credential.create({ integrationID: "devin-subscription", label: "Synthetic second account", value: { type: "key", key: secondToken }, activate: true });
    await waitInventory(["fixture-model-3"]);
    await client.credential.activate({ credentialID: original.id });
    await waitInventory(["fixture-model-1", "fixture-model-2"]);
    await client.credential.create({ integrationID: "devin-subscription", label: "Synthetic refused account", value: { type: "key", key: refusedToken }, activate: true });
    for (;;) {
      const providers = await client.provider.list();
      if (providers.data.some((provider) => provider.id === "devin-subscription" && provider.name.includes("catalog lookup failed"))) break;
      if ((await changed.next()).done) throw new Error("Catalog refusal did not become visible.");
    }
    await waitInventory([]);
    await client.credential.activate({ credentialID: original.id });
    await waitInventory(["fixture-model-1", "fixture-model-2"]);
  } finally { catalogEvents.abort(); }
  console.log(JSON.stringify({ opencode:version,sessionID:session.id,sequence:["A","Devin model 1","Devin model 2","A"],actualHostToolExecutions:tools,
    historyAndToolResultsPreserved:true,nativeModelRoutes:routes,strictlyCheckedHostDeclarations:declarations,catalogReads,
    http1AndDoubleGzip:true,syntheticEncryptedDesktopImportViaHostCommand:true,bundledImmutableImporterUsed:bundled,commandStdoutNotExposedToClient:true,providerBundle:bundled,standaloneBundleWithoutDevelopmentDependencies:bundled,
    discoverableBeforeAuthentication:true,accountCatalogsNeverMixed:true,refusedAccountDoesNotReuseOldCatalog:true,
    originalSchemasDescriptionsAndArgumentsPreserved:true,catalogLimitsPreserved:true,catalogLimitsUnknown:unknownLimits,
    explicitOutputBudgetsPreserved:[65_536,16_384],newlineLimitAbsent:true,
    realDevinRequests:0,realCredentialOrKeychainReads:0,fixtureDirectory:root },null,2));
  }
} catch (error) {
  await writeFile(join(root,"runtime-output.log"),output); await writeFile(join(root,"fixture-audits.json"),JSON.stringify(audits,null,2));
  await writeFile(join(root,"driver-inputs.json"),JSON.stringify(driverInputs,null,2));
  throw new Error(`Devin continuation probe failed in ${phase}; ${fixtureError ?? ""}; runtime=${output.slice(-4000)}; fixtures=${root}`,{ cause:error });
} finally { clearTimeout(deadline); web?.kill("SIGTERM"); child.kill("SIGTERM"); await fixtures.stop(true); }
