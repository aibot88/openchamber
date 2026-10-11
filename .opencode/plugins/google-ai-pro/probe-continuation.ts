// Actual OpenCode 2 agent-loop probe. All model replies, OAuth grants and files
// are isolated fixtures. No user's credentials or Google traffic are involved.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { assertSubscriptionSchema } from "./fixtures/schema-validator.ts";
import { tmpdir } from "node:os";

const binary = process.env.OPENCODE_BIN ?? (process.platform === "darwin" ? "/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode" : "opencode");
const reportedVersion = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
const version = reportedVersion.match(/^(?:opencode v)?(2\.\d+\.\d+(?:[-+][\w.-]+)?)$/)?.[1];
if (!version) throw new Error("This probe requires OpenCode 2. Set OPENCODE_BIN to the matching CLI.");
const root = await mkdtemp(join(process.env.PROBE_TMPDIR ?? tmpdir(), "gemini-continuation-"));
const project = join(root, "project");
const plugin = join(root, "fixture-plugin");
await mkdir(project); await mkdir(plugin);
await writeFile(join(project, "memory.txt"), "TOOL-MARKER-9018");
let phase = "A-first";
const audits: { phase: string; url: string; payload: any }[] = [];
const tools: string[] = [];
let checkedDeclarations = 0;
const confirmInput = z.toJSONSchema(z.object({
  limit: z.number().int().positive().max(100), exclusiveMinimum: z.string().min(1),
  title: z.string().min(1), format: z.string().min(1), default: z.string().min(1),
}));
const confirmArgs = { limit: 1, exclusiveMinimum: "argument-data", title: "argument-data", format: "argument-data", default: "argument-data" };
const sameArgs = (input: Record<string, unknown>) => Object.keys(input).length === Object.keys(confirmArgs).length &&
  Object.entries(confirmArgs).every(([key, value]) => input[key] === value);
const fixtures = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/tool/")) { tools.push(path.slice(6)); return new Response("ok"); }
  const payload = await request.json() as any;
  const url = request.headers.get("x-fixture-upstream") ?? request.url;
  audits.push({ phase, url, payload });
  if (url.endsWith(":fetchAvailableModels")) {
    return Response.json({ models: { "gemini-3.1-pro-low": {}, "gemini-pro-agent": {},
      "gemini-3.8-flash-low": {}, "gemini-3.8-flash-medium": {}, "gemini-3.8-flash-high": {} } });
  }
  const inner = payload.request ?? payload;
  if (payload.request) for (const tool of inner.tools ?? []) for (const declaration of tool.functionDeclarations ?? []) {
    if (declaration.parameters !== undefined) { assertSubscriptionSchema(declaration.parameters); checkedDeclarations++; }
    if (declaration.response !== undefined) assertSubscriptionSchema(declaration.response, true);
    if (declaration.parametersJsonSchema !== undefined) throw new Error("JSON Schema carrier leaked to the subscription fixture.");
  }
  const contents = JSON.stringify(inner.contents);
  const declaration = (suffix: string) => inner.tools?.flatMap((tool: any) => tool.functionDeclarations ?? [])
    .find((tool: any) => tool.name.endsWith(suffix))?.name ?? suffix;
  if (audits.length > 20) return new Response("Fixture request limit reached", { status: 400 });
  let parts: any[];
  if (phase === "A-first" && !contents.includes("TOOL-MARKER-9018")) {
    parts = [{ functionCall: { id: "fixture-call-read", name: declaration("execute"), args: { code: "return await tools.fixture_read();" } }, thoughtSignature: "Zml4dHVyZS1zaWduYXR1cmU=" }];
  } else if (phase === "Flash" && !contents.includes("CONFIRMED-MARKER-9018")) {
    if (!contents.includes("TOOL-MARKER-9018")) throw new Error("Flash lost A's read result.");
    parts = [{ functionCall: { id: "fixture-call-confirm", name: declaration("fixture_confirm"), args: confirmArgs }, thoughtSignature: "Zmxhc2gtc2lnbmF0dXJl" }];
  } else {
    if (!contents.includes("TOOL-MARKER-9018")) throw new Error(`${phase} lost prior tool history.`);
    parts = [{ text: `Fixture ${phase} retained TOOL-MARKER-9018.` }];
  }
  const response = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, totalTokenCount: 112 } };
  const wire = payload.request ? { response } : response;
  return new Response(gzipSync(`data: ${JSON.stringify(wire)}\n\n`), { headers: { "Content-Type": "text/event-stream", "Content-Encoding": "gzip" } });
} });
const origin = `http://127.0.0.1:${fixtures.port}`;
const source = process.env.PROBE_PLUGIN_ENTRY ?? fileURLToPath(new URL("./index.ts", import.meta.url));
const httpSource = fileURLToPath(new URL("./subscription-http.ts", import.meta.url));
await writeFile(join(plugin, "package.json"), JSON.stringify({ type: "module", main: "index.ts" }));
await writeFile(join(plugin, "index.ts"), `
import { Plugin, Model, Provider } from '@opencode/plugin';
import { readFile } from 'node:fs/promises';
import { request as httpRequest, Agent } from 'node:http';
import { setup } from ${JSON.stringify(source)};
import { createSubscriptionHTTP } from ${JSON.stringify(httpSource)};
export default Plugin.define({ id: 'fixture.continuation', async setup(ctx) {
  await ctx.provider.transform(editor => editor.add({ info: {
    ...Provider.Info.empty(Provider.ID.make('offline-a')), name: 'Offline A', activation: 'enabled',
    package: '@opencode/ai/providers/google', settings: { apiKey: 'fixture', baseURL: '${origin}/v1beta' },
  }, models: [Model.Info.default(Provider.ID.make('offline-a'), Model.ID.make('gemini-3.1-pro'))] }));
  await ctx.session.hook('title', event => { event.result = 'Fixture continuation'; });
  await ctx.tool.transform(editor => {
    for (const name of ['fixture_read', 'fixture_confirm']) editor.add({ name,
      description: 'Isolated fixture tool', input: name === 'fixture_confirm' ? ${JSON.stringify(confirmInput)} : { type: 'object', properties: {}, additionalProperties: false },
      options: { codemode: name === 'fixture_read' },
      async execute(input) {
        await fetch('${origin}/tool/' + name, { method: 'POST' });
        const expected = ${JSON.stringify(confirmArgs)};
        if (name === 'fixture_confirm' && (Object.keys(input).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => input[key] !== value))) throw new Error('Fixture arguments were rewritten.');
        return { content: name === 'fixture_read' ? await readFile(${JSON.stringify(join(project, "memory.txt"))}, 'utf8') : 'CONFIRMED-MARKER-9018' };
      }
    });
  });
  const agent = new Agent({ keepAlive: true });
  const wire = createSubscriptionHTTP({ env: {}, request: (url, options, callback) =>
    httpRequest('${origin}/subscription-fixture', { ...options, agent,
      headers: [...options.headers, 'x-fixture-upstream', url.toString()] }, callback) });
  const cleanup = await setup(ctx, { send: wire.fetch });
  return async () => { wire.dispose(); agent.destroy(); await cleanup(); };
} });
`);
await writeFile(join(project, "opencode.json"), JSON.stringify({ plugins: [plugin],
  agents: { build: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } } }));
const password = randomBytes(32).toString("base64url");
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project, env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(OPENCODE_|GOOGLE_|GEMINI_|OPENAI_|ANTHROPIC_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)/.test(key) && !key.endsWith("_API_KEY"))),
    HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DB: ":memory:", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password,
  }, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
const ready = new Promise<string>((resolve, reject) => {
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
    if (match) resolve(match[0]);
  };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`Fixture runtime exited (${code}): ${output.slice(-2500)}`)));
});
const deadline = setTimeout(() => child.kill("SIGTERM"), 60_000);
try {
  const client = OpenCode.make({ baseUrl: await ready, headers: {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": project,
  } });
  const controller = new AbortController();
  const iterator = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
  await iterator.next(); await client.location.reload();
  for (;;) {
    const models = await client.model.list();
    if (models.data.some((model) => model.providerID === "google-ai-pro")) break;
    const plugins = await client.plugin.list();
    const failed = plugins.data.find((plugin) => plugin.state.status === "failed");
    if (failed) throw new Error(`Fixture plugin failed: ${JSON.stringify(failed)}`);
    const event = await iterator.next();
    if (event.done) throw new Error("Plugin did not load.");
  }
  controller.abort();
  await client.credential.create({ integrationID: "google-ai-pro", label: "Isolated fixture only", activate: true, value: {
    type: "oauth", methodID: "antigravity-oauth", access: "fixture-access", refresh: "fixture-refresh",
    expires: Date.now() + 3_600_000, metadata: { projectId: "fixture-project" },
  } });
  const session = await client.session.create({ title: "Tool continuation fixture" });
  const sessionID = session.id;
  for (const step of [
    { phase: "A-first", providerID: "offline-a", id: "gemini-3.1-pro", variant: undefined },
    { phase: "Pro", providerID: "google-ai-pro", id: "gemini-3.1-pro", variant: "high" },
    { phase: "Flash", providerID: "google-ai-pro", id: "gemini-3.8-flash", variant: "medium" },
    { phase: "A-back", providerID: "offline-a", id: "gemini-3.1-pro", variant: undefined },
  ]) {
    phase = step.phase;
    await client.session.switchModel({ sessionID, model: { providerID: step.providerID, id: step.id, variant: step.variant } });
    await client.session.prompt({ sessionID, text: "Continue the isolated tool fixture without repeating earlier reads." });
    await client.session.wait({ sessionID });
    const context = await client.session.context({ sessionID });
    const last = context.at(-1);
    if (last && JSON.stringify(last).includes('"type":"error"')) throw new Error(`Agent loop failed in ${phase}: ${JSON.stringify(last)}`);
  }
  const context = await client.session.context({ sessionID });
  if (!JSON.stringify(context).includes("TOOL-MARKER-9018") || !JSON.stringify(context).includes("CONFIRMED-MARKER-9018")) {
    throw new Error("Persisted context lost a fixture tool result.");
  }
  if (JSON.stringify(tools) !== JSON.stringify(["fixture_read", "fixture_confirm"])) throw new Error(`Unexpected tool execution/repetition: ${JSON.stringify(tools)}`);
  const subscription = audits.filter((audit) => audit.payload.request);
  if (!checkedDeclarations) throw new Error("No real host tool declarations were validated.");
  if (!audits.some((audit) => !audit.payload.request && JSON.stringify(audit.payload.tools ?? []).includes('"exclusiveMinimum":0'))) {
    throw new Error("The host did not produce the positive-limit regression schema before subscription conversion.");
  }
  if (!subscription.some((audit) => audit.payload.model === "gemini-pro-agent") || !subscription.some((audit) => audit.payload.model === "gemini-3.8-flash-medium")) {
    throw new Error("Account-bound wire model routing did not run.");
  }
  for (const audit of subscription) {
    if (new URL(audit.url).origin !== "https://daily-cloudcode-pa.googleapis.com") throw new Error("Incorrect subscription tier.");
    if (!JSON.stringify(audit.payload.request.contents).includes("TOOL-MARKER-9018")) throw new Error("A subscription request lost A's tool result.");
    if (!audit.payload.request.sessionId.startsWith(sessionID)) throw new Error("Subscription started a separate conversation.");
    const budget = audit.payload.request.generationConfig?.thinkingConfig?.thinkingBudget;
    if (budget !== (audit.phase === "Pro" ? 10001 : 4000)) throw new Error("Native thinking variants were not lowered to their subscription budgets.");
    const confirm = audit.payload.request.tools?.flatMap((tool: any) => tool.functionDeclarations ?? []).find((tool: any) => tool.name.endsWith("fixture_confirm"));
    if (!confirm?.parameters.properties.limit.description.includes("exclusiveMinimum: 0")) throw new Error("The host's positive-limit schema lost its constraint hint.");
  }
  const back = audits.filter((audit) => audit.phase === "A-back");
  if (!back.some((audit) => JSON.stringify(audit.payload.contents).includes("CONFIRMED-MARKER-9018"))) throw new Error("A did not receive the Gemini fixture tool result.");
  if (!back.some((audit) => audit.payload.contents.some((content: any) => content.parts.some((part: any) =>
    part.functionCall?.name.endsWith("fixture_confirm") && sameArgs(part.functionCall.args))))) {
    throw new Error("Arguments named after schema keywords did not survive the return to A.");
  }
  console.log(JSON.stringify({ opencode: version, sessionID, sequence: ["A", "Pro/high", "Flash/medium", "A"],
    actualHostToolExecutions: tools, historyAndToolResultsPreserved: true, subscriptionBridgeRequests: subscription.length,
    http1SenderAndGzipVerifiedInHost: true,
    strictlyValidatedHostDeclarations: checkedDeclarations, positiveLimitSchemaRegression: true, keywordNamedArgumentsPreserved: true,
    googleRequests: 0, fixtureDirectory: root }, null, 2));
} catch (error) {
  await writeFile(join(root, "runtime-output.log"), output);
  await writeFile(join(root, "fixture-audits.json"), JSON.stringify(audits.slice(0, 8), null, 2));
  throw new Error(`Continuation probe failed in ${phase}; requests=${audits.length}; tools=${JSON.stringify(tools)}; runtime=${output.slice(-5000)}`, { cause: error });
} finally {
  clearTimeout(deadline); child.kill("SIGTERM"); await fixtures.stop(true);
}
