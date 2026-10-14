import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

test("the importer refuses direct invocation and emits no secret stdout", async () => {
  const result = await new Promise<{ failed: boolean; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [fileURLToPath(new URL("../import-command.ts", import.meta.url)), "--not-an-auth-attempt"],
      { encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => resolve({ failed: !!error, stdout, stderr }));
  });
  expect(result.failed).toBe(true); expect(result.stdout).toBe(""); expect(result.stderr).toContain("connection method");
});
