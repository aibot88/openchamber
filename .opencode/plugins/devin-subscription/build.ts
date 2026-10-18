import { mkdir, copyFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { isBuiltin } from "node:module";

const root = fileURLToPath(new URL(".", import.meta.url));
const outdir = join(root, "dist");
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "index.ts"), join(root, "import-command.ts")],
  outdir, target: "bun", format: "esm", metafile: true,
});
if (!result.success) throw new AggregateError(result.logs, "Devin provider bundle failed.");
if (!result.metafile) throw new Error("Bun did not report the bundle's dependencies.");
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!isBuiltin(dependency.path) && dependency.path !== "bun:sqlite") {
      throw new Error(`Bundle still requires an external dependency: ${dependency.path}`);
    }
  }
}
await writeFile(join(outdir, "package.json"), JSON.stringify({ name: "opencode-devin-subscription-v2", version: "0.1.5", private: true, type: "module", main: "./index.js" }, null, 2) + "\n");
await copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(outdir, "THIRD_PARTY_NOTICES.md"));
await copyFile(join(root, "README.md"), join(outdir, "README.md"));
await mkdir(join(outdir, "licenses"), { recursive: true });
const packageRoots = new Set<string>();
for (const input of Object.keys(result.metafile?.inputs ?? {})) {
  const absolute = resolve(root, input);
  const end = absolute.lastIndexOf("/node_modules/");
  if (end === -1) continue;
  const suffix = absolute.slice(end + "/node_modules/".length).split("/");
  const name = suffix[0].startsWith("@") ? suffix.slice(0, 2).join("/") : suffix[0];
  packageRoots.add(absolute.slice(0, end) + "/node_modules/" + name);
}
for (const directory of packageRoots) {
  const licenses = (await readdir(directory)).filter((name) => /^licen[cs]e(?:\..*)?$/i.test(name));
  const name = directory.slice(directory.lastIndexOf("/node_modules/") + "/node_modules/".length).replaceAll("/", "_");
  if (!licenses.length) {
    if (!/^@opencode_(?:plugin|schema|client|ai|util)$/.test(name)) throw new Error(`Bundled package has no license file: ${directory}`);
    // The pinned OpenCode 2.0.25 npm packages declare MIT but omit LICENSE.
    // Retain the exact repository license for that tag with the bundle.
    await copyFile(join(root, "LICENSE.OpenCode.txt"), join(outdir, "licenses", `${name}-LICENSE.txt`));
  }
  for (const license of licenses) await copyFile(join(directory, license), join(outdir, "licenses", `${name}-${license}.txt`));
}
console.log(`Built ${result.outputs.length} Devin provider entrypoints. No credentials or network requests were used.`);
