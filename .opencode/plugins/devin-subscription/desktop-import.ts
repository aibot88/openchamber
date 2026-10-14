import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { desktopSession } from "./credentials.ts";

export const STORAGE_KEY = 'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}';
// Devin's packaged migration uses '<name> Safe Storage' / '<name> Key'.
// The user confirmed these exact nonsecret attributes in Keychain Access.
// Stock Electron's account naming is insufficient here. See THIRD_PARTY_NOTICES.md.
export const KEYCHAIN_SERVICE = "Devin Safe Storage";
export const KEYCHAIN_ACCOUNT = "Devin Key";
const encryptedRecord = z.object({ type: z.literal("Buffer"), data: z.array(z.number().int().min(0).max(255)).min(19).max(65536) });
class DesktopDatabaseBusy extends Error {}

export function decryptDesktopRecord(record: string, password: string): string {
  let key: Buffer | undefined;
  let clear: Buffer | undefined;
  try {
    if (record.length > 300_000 || !password || password.length > 4096) throw new Error();
    const parsed = encryptedRecord.parse(JSON.parse(record));
    const encrypted = Buffer.from(parsed.data);
    if (encrypted.subarray(0, 3).toString("ascii") !== "v10" || (encrypted.length - 3) % 16 !== 0) throw new Error();
    key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    clear = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return desktopSession(new TextDecoder("utf-8", { fatal: true }).decode(clear));
  } catch {
    throw new Error("The specified Devin Desktop login record could not be decrypted or validated. No other storage or Keychain entry was tried.");
  } finally { key?.fill(0); clear?.fill(0); }
}

async function readLoginRecord(home: string): Promise<string> {
  try {
    const directory = join(await realpath(home), "Library/Application Support/Devin/User/globalStorage");
    const path = join(directory, "state.vscdb");
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || await realpath(directory) !== directory || before.size > 512n * 1024n * 1024n) throw new Error();
    const assertNoJournal = async () => {
      for (const suffix of ["-wal", "-journal"]) {
        try {
          const value = await lstat(path + suffix);
          if (value.isSymbolicLink() || value.size) throw new DesktopDatabaseBusy("Quit Devin before importing its login. Its database journal is still active; the importer did not open or modify it.");
        } catch (error) {
          if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success) throw error;
        }
      }
    };
    await assertNoJournal();
    const { Database } = await import("bun:sqlite");
    // A plain SQLite READONLY open can still change -shm read marks. Immutable
    // mode touches neither journals nor shared memory. Refuse WAL beforehand
    // so it cannot read a stale pre-WAL login or recover the source database.
    const db = new Database(pathToFileURL(path).href + "?mode=ro&immutable=1", { readonly: true, create: false, strict: true });
    let record: string;
    try {
      const rows = db.query("SELECT value FROM ItemTable WHERE key = ? AND length(value) <= 300000 LIMIT 2").all(STORAGE_KEY);
      const result = z.array(z.object({ value: z.string() })).length(1).safeParse(rows);
      if (!result.success) throw new Error();
      record = result.data[0].value;
    } finally { db.close(); }
    await assertNoJournal();
    const after = await lstat(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new DesktopDatabaseBusy("The Devin login database changed during import. Quit Devin and try importing again; no credential was saved.");
    }
    return record;
  } catch (error) {
    if (error instanceof DesktopDatabaseBusy) throw error;
    throw new Error("The specified Devin Desktop login entry is unavailable. The source database was opened read-only; no other entry was inspected.");
  }
}

async function safeStoragePassword(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    { encoding: "utf8", timeout: 60_000, maxBuffer: 8192, signal }, (error, stdout) => {
      if (error || !stdout.trim()) reject(new Error("Access to the Devin Safe Storage Keychain entry was denied or unavailable. No other Keychain entry was tried."));
      else resolve(stdout.replace(/\r?\n$/, ""));
    }));
}

export async function importDesktopLogin(options: {
  platform?: NodeJS.Platform; home?: string;
  signal?: AbortSignal;
  readRecord?: (home: string) => Promise<string>; readPassword?: () => Promise<string>;
} = {}): Promise<string> {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Devin Desktop login import is supported only on a macOS OpenCode host.");
  options.signal?.throwIfAborted();
  const record = await (options.readRecord ?? readLoginRecord)(options.home ?? homedir());
  options.signal?.throwIfAborted();
  const password = await (options.readPassword ? options.readPassword() : safeStoragePassword(options.signal));
  options.signal?.throwIfAborted();
  return decryptDesktopRecord(record, password);
}
