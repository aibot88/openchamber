import { mkdir, copyFile, writeFile, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { isBuiltin } from "node:module";

const root = fileURLToPath(new URL(".", import.meta.url));
const outdir = join(root, "dist");
await mkdir(outdir, { recursive: true });
const result = await Bun.build({ entrypoints: [join(root, "index.ts")], outdir, target: "node", format: "esm", metafile: true });
if (!result.success) throw new AggregateError(result.logs, "Google subscription provider bundle failed.");
if (!result.metafile) throw new Error("Bun did not report the bundle's dependencies.");
for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) {
  if (!isBuiltin(dependency.path)) throw new Error(`Bundle still requires an external dependency: ${dependency.path}`);
}
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(outdir, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version,
  private: true, type: "module", main: "./index.js" }, null, 2) + "\n");
for (const name of ["README.md", "VALIDATION.md", "THIRD_PARTY_NOTICES.md"]) await copyFile(join(root, name), join(outdir, name));
await mkdir(join(outdir, "licenses"), { recursive: true });
const packageRoots = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
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
    await copyFile(join(root, "LICENSE.OpenCode.txt"), join(outdir, "licenses", `${name}-LICENSE.txt`));
  }
  for (const license of licenses) await copyFile(join(directory, license), join(outdir, "licenses", `${name}-${license}.txt`));
}
console.log("Built Google subscription provider bundle. No credentials or network requests were used.");
