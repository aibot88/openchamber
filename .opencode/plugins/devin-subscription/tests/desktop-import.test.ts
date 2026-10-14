import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decryptDesktopRecord, importDesktopLogin, STORAGE_KEY, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from "../desktop-import.ts";
import { desktopSession, validateToken } from "../credentials.ts";

const token = "devin-session-token$synthetic-token-never-valid";
function encrypted(plaintext: string, password = "synthetic-safe-storage") {
  const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 32));
  return JSON.stringify(Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]));
}
const record = encrypted(JSON.stringify([{ accessToken: token, account: { label: "synthetic" }, scopes: [] }]));

describe("explicit desktop import", () => {
  test("decrypts one current session using the macOS v10 format", () => {
    expect(decryptDesktopRecord(record, "synthetic-safe-storage")).toBe(token);
  });
  test("uses only the Devin service and account confirmed by packaged migration and user metadata", () => {
    expect(KEYCHAIN_SERVICE).toBe("Devin Safe Storage"); expect(KEYCHAIN_ACCOUNT).toBe("Devin Key");
  });
  test("password failure never includes ciphertext, token or Keychain output", () => {
    expect(() => decryptDesktopRecord(record, "wrong")).toThrow("No other storage or Keychain entry");
    try { decryptDesktopRecord(record, "wrong"); } catch (error) { expect(String(error)).not.toContain(token); }
  });
  test.each(["not-json", "{}", '[{"accessToken":"old-codeium-key"}]', "[]", JSON.stringify([{ accessToken: token }, { accessToken: token }])])("rejects malformed/old/ambiguous login: %s", (value) => {
    expect(() => desktopSession(value)).toThrow("exactly one");
    expect(() => decryptDesktopRecord(encrypted(value), "synthetic-safe-storage")).toThrow("could not be decrypted or validated");
  });
  test.each(["devin-session-token$bad\nheader", "cloud-api-key", "devin-session-token$short", "devin-session-token$" + "a".repeat(8192)])("rejects non-session credential", (value) => {
    expect(() => validateToken(value)).toThrow("valid Devin Desktop");
  });
  test.each(["v11", "v20", "xxx"])("does not downgrade unknown encryption %s", (prefix) => {
    const raw = JSON.parse(record); raw.data.splice(0, 3, ...Buffer.from(prefix));
    expect(() => decryptDesktopRecord(JSON.stringify(raw), "synthetic-safe-storage")).toThrow("No other storage");
  });
  test("unsupported host reads no record or password", async () => {
    let reads = 0;
    await expect(importDesktopLogin({ platform: "linux", readRecord: async () => { reads++; return record; }, readPassword: async () => { reads++; return "synthetic-safe-storage"; } })).rejects.toThrow("macOS");
    expect(reads).toBe(0);
  });
  test("missing login does not access Keychain", async () => {
    let reads = 0;
    await expect(importDesktopLogin({ platform: "darwin", home: "/nonexistent-fixture-home", readPassword: async () => { reads++; return "synthetic-safe-storage"; } })).rejects.toThrow("unavailable");
    expect(reads).toBe(0);
  });
  test("reads only the specified SQLite entry and leaves source bytes unchanged", async () => {
    const home = await mkdtemp(join(process.env.PROBE_TMPDIR ?? tmpdir(), "devin-import-fixture-"));
    const directory = join(home, "Library/Application Support/Devin/User/globalStorage");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "state.vscdb");
    const db = new Database(path); db.run("CREATE TABLE ItemTable (key TEXT UNIQUE, value TEXT)");
    db.query("INSERT INTO ItemTable VALUES (?,?)").run(STORAGE_KEY, record);
    db.query("INSERT INTO ItemTable VALUES (?,?)").run('secret://unrelated', "do-not-parse-or-read"); db.close();
    const before = await readFile(path);
    let passwordReads = 0;
    const imported = await importDesktopLogin({ platform: "darwin", home, readPassword: async () => { passwordReads++; return "synthetic-safe-storage"; } });
    expect(imported).toBe(token); expect(passwordReads).toBe(1); expect(await readFile(path)).toEqual(before);
  });
  test("rejects a symlink instead of following it into other storage", async () => {
    const home = await mkdtemp(join(process.env.PROBE_TMPDIR ?? tmpdir(), "devin-import-link-"));
    const directory = join(home, "Library/Application Support/Devin/User/globalStorage");
    await mkdir(directory, { recursive: true }); await symlink("/nonexistent-other-database", join(directory, "state.vscdb"));
    let reads = 0;
    await expect(importDesktopLogin({ platform: "darwin", home, readPassword: async () => { reads++; return "unused"; } })).rejects.toThrow("unavailable");
    expect(reads).toBe(0);
  });
  test("an active WAL is refused before Keychain access without changing any database or sidecar bytes", async () => {
    const home = await mkdtemp(join(process.env.PROBE_TMPDIR ?? tmpdir(), "devin-import-wal-"));
    const directory = join(home, "Library/Application Support/Devin/User/globalStorage"); await mkdir(directory, { recursive: true });
    const path = join(directory, "state.vscdb");
    const db = new Database(path); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT,value TEXT)");
    db.query("INSERT INTO ItemTable VALUES (?,?)").run(STORAGE_KEY, record);
    try {
      const paths = [path, path + "-wal", path + "-shm"];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      let reads = 0;
      await expect(importDesktopLogin({ platform: "darwin", home, readPassword: async () => { reads++; return "synthetic-safe-storage"; } })).rejects.toThrow("Quit Devin");
      expect(reads).toBe(0); expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
    } finally { db.close(); }
    expect(await importDesktopLogin({ platform: "darwin", home, readPassword: async () => "synthetic-safe-storage" })).toBe(token);
  });
  test("cancellation before reading storage accesses no credentials", async () => {
    const controller = new AbortController(); controller.abort();
    let reads = 0;
    await expect(importDesktopLogin({ platform: "darwin", signal: controller.signal, readRecord: async () => { reads++; return record; }, readPassword: async () => { reads++; return "synthetic-safe-storage"; } })).rejects.toThrow();
    expect(reads).toBe(0);
  });
  test("cancellation after reading storage stops before Keychain access", async () => {
    const controller = new AbortController(); let reads = 0;
    await expect(importDesktopLogin({ platform: "darwin", signal: controller.signal, readRecord: async () => { controller.abort(); return record; }, readPassword: async () => { reads++; return "synthetic-safe-storage"; } })).rejects.toThrow();
    expect(reads).toBe(0);
  });
});
