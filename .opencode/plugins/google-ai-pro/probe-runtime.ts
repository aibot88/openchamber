import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { OpenCode } from "@opencode/client";
import { tmpdir } from "node:os";

const binary = process.env.OPENCODE_BIN ?? (process.platform === "darwin" ? "/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode" : "opencode");
const reportedVersion = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
const version = reportedVersion.match(/^(?:opencode v)?(2\.\d+\.\d+(?:[-+][\w.-]+)?)$/)?.[1];
if (!version) throw new Error("This probe requires OpenCode 2. Set OPENCODE_BIN to the matching CLI.");
const root = await mkdtemp(join(process.env.PROBE_TMPDIR ?? tmpdir(), "gemini-subscription-probe-"));
const config = join(root, "config");
const project = join(root, "project");
const password = randomBytes(32).toString("base64url");
await mkdir(join(config, "opencode"), { recursive: true });
await mkdir(project);
await writeFile(join(project, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugins: [process.env.PROBE_PLUGIN_DIRECTORY ?? fileURLToPath(new URL("./", import.meta.url))],
  providers: {
    "offline-a": {
      name: "Offline model A fixture",
      package: "@opencode/ai/providers/google",
      settings: { apiKey: "offline-placeholder", baseURL: "https://offline.invalid/v1beta" },
      models: { "gemini-3.1-pro": { name: "Offline model A" } },
    },
  },
}));
// This process sees a separate home/config/data tree and never loads the user's
// credentials, MCP servers or plugins. It makes no Google inference requests.
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project,
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(OPENCODE_|GOOGLE_|GEMINI_|OPENAI_|ANTHROPIC_)/.test(key) && !key.endsWith("_API_KEY"))),
    HOME: root,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DB: ":memory:",
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_PASSWORD: password,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
const ready = new Promise<string>((resolve, reject) => {
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
    if (match) resolve(match[0]);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`Probe server exited (${code}): ${output.slice(-3000)}`)));
});
const timeout = setTimeout(() => child.kill("SIGTERM"), 45_000);
try {
  const url = await ready;
  const client = OpenCode.make({ baseUrl: url, headers: {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "x-opencode-directory": project,
  } });
  const controller = new AbortController();
  const events = client.event.subscribe({ signal: controller.signal });
  const iterator = events[Symbol.asyncIterator]();
  await iterator.next();
  await client.location.reload();
  let plugins = await client.plugin.list();
  let models = await client.model.list();
  if (!models.data.some((model) => model.providerID === "google-ai-pro")) {
    // Startup installs/evaluates plugins asynchronously. Wait on the runtime's
    // event stream, not a timed polling loop.
    for (;;) {
      const event = await iterator.next();
      if (event.done) throw new Error("Probe event stream ended before plugin activation.");
      if (event.value.type === "provider.updated" || event.value.type === "plugin.updated") {
        plugins = await client.plugin.list();
        models = await client.model.list();
        if (models.data.some((model) => model.providerID === "google-ai-pro")) break;
      }
    }
  }
  controller.abort();
  const configuration = await client.config.get();
  const model = models.data.find((model) => model.providerID === "google-ai-pro");
  if (!model) throw new Error(`Subscription model missing. Plugins: ${JSON.stringify(plugins)}. Config: ${JSON.stringify(configuration)}. Probe output: ${output.slice(-4000)}`);
  const subscriptionCatalog = models.data.filter((model) => model.providerID === "google-ai-pro");
  if (JSON.stringify(subscriptionCatalog.map((model) => model.id).sort()) !== JSON.stringify(["gemini-3.1-pro", "gemini-3.8-flash"])) {
    throw new Error("The installed plugin did not register both subscription models.");
  }
  const flash = subscriptionCatalog.find((model) => model.id === "gemini-3.8-flash");
  if (flash?.modelID !== "gemini-3.8-flash" ||
    JSON.stringify(flash.variants.map((variant) => variant.id).sort()) !== JSON.stringify(["high", "low", "medium"])) {
    throw new Error("The installed Flash catalog has an incorrect backend ID or variants.");
  }
  const integration = await client.integration.get({ integrationID: "google-ai-pro" });
  if (!integration.data.methods.some((method) => "id" in method && method.id === "antigravity-oauth")) {
    throw new Error("Subscription OAuth method missing.");
  }
  if (integration.data.connections.length !== 0 || integration.data.methods.some((method) => method.type === "key" || method.type === "env")) {
    throw new Error("The unconnected subscription must not advertise credentials or API-key authentication.");
  }
  const session = await client.session.create({ title: "Offline Gemini switch probe" });
  const sessionID = session.id;
  await client.session.switchModel({ sessionID, model: { providerID: "offline-a", id: "gemini-3.1-pro" } });
  await client.session.synthetic({ sessionID, text: "Persist marker MEMORY-7391 across model switches." });
  const before = await client.session.context({ sessionID });
  if (!JSON.stringify(before).includes("MEMORY-7391")) throw new Error("Probe marker was not persisted.");
  await client.session.switchModel({ sessionID, model: { providerID: "google-ai-pro", id: "gemini-3.1-pro" } });
  const switched = await client.session.get({ sessionID });
  const after = await client.session.context({ sessionID });
  await client.session.switchModel({ sessionID, model: { providerID: "google-ai-pro", id: "gemini-3.8-flash", variant: "medium" } });
  const switchedFlash = await client.session.get({ sessionID });
  const afterFlash = await client.session.context({ sessionID });
  await client.session.switchModel({ sessionID, model: { providerID: "offline-a", id: "gemini-3.1-pro" } });
  const back = await client.session.context({ sessionID });
  const content = (messages: typeof before) => messages.filter((message) => message.type !== "model-switched");
  if (JSON.stringify(content(before)) !== JSON.stringify(content(after)) ||
    JSON.stringify(content(before)) !== JSON.stringify(content(afterFlash)) ||
    JSON.stringify(content(before)) !== JSON.stringify(content(back))) {
    throw new Error("Model switching changed stored context.");
  }
  console.log(JSON.stringify({
    opencode: version,
    plugin: "loaded",
    provider: model.providerID,
    oauth: "registered",
    signInRequired: true,
    sessionID,
    switchedModel: switched.model,
    switchedFlash: switchedFlash.model,
    models: subscriptionCatalog.map((model) => ({ id: model.id, modelID: model.modelID, variants: model.variants.map((variant) => variant.id) })),
    historyPreserved: true,
    switchSequence: ["offline-a/gemini-3.1-pro", "google-ai-pro/gemini-3.1-pro", "google-ai-pro/gemini-3.8-flash", "offline-a/gemini-3.1-pro"],
    googleRequests: 0,
    fixtureDirectory: root,
  }, null, 2));
} finally {
  clearTimeout(timeout);
  child.kill("SIGTERM");
}
