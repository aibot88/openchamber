import { randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { CLIENT_VERSION, MAX_BYTES } from "./constants.ts";
import { text } from "./protobuf.ts";

export function metadata(token: string): Buffer {
  return Buffer.concat([text(1, "chisel"), text(2, CLIENT_VERSION), text(3, token),
    text(4, "en"), text(5, "windows"), text(7, CLIENT_VERSION), text(12, "chisel"),
    text(31, randomBytes(366).toString("hex"))]);
}

export function envelope(payload: Uint8Array, flags = 0): Buffer {
  if (flags < 0 || flags > 3 || !Number.isInteger(flags) || payload.byteLength > MAX_BYTES) throw new Error("Invalid Connect frame.");
  const body = flags & 1 ? gzipSync(payload) : payload;
  if (body.byteLength > MAX_BYTES) throw new Error("Connect frame exceeds the size limit.");
  const header = Buffer.alloc(5); header[0] = flags; header.writeUInt32BE(body.byteLength, 1);
  return Buffer.concat([header, body]);
}

export async function readLimited(response: Response, limit = MAX_BYTES): Promise<Buffer> {
  if (!response.body) throw new Error("Missing Devin response body.");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(parts);
      size += next.value.byteLength;
      if (size > limit) throw new Error("Devin response exceeds the size limit.");
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const trailer = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }).optional() });
export async function* frames(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const header = Buffer.alloc(5);
  let headerRead = 0;
  let payload: Buffer | undefined;
  let payloadRead = 0;
  let ended = false;
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 32 * 1024 * 1024) throw new Error("Devin stream exceeds the size limit.");
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      let offset = 0;
      // Each input byte is copied once, even when a frame arrives one byte at
      // a time. Repeatedly concatenating the partial frame is quadratic.
      while (offset < chunk.length) {
        if (ended) throw new Error("Invalid Connect frame header.");
        if (headerRead < 5) {
          const count = Math.min(5 - headerRead, chunk.length - offset);
          chunk.copy(header, headerRead, offset, offset + count); offset += count; headerRead += count;
          if (headerRead < 5) continue;
          if (header[0] > 3 || header.readUInt32BE(1) > MAX_BYTES) throw new Error("Invalid Connect frame header.");
          payload = Buffer.alloc(header.readUInt32BE(1)); payloadRead = 0;
        }
        if (!payload) throw new Error("Missing Connect frame buffer.");
        const count = Math.min(payload.length - payloadRead, chunk.length - offset);
        chunk.copy(payload, payloadRead, offset, offset + count); offset += count; payloadRead += count;
        if (payloadRead < payload.length) continue;
        const flags = header[0];
        const decoded = flags & 1 ? gunzipSync(payload, { maxOutputLength: MAX_BYTES }) : payload;
        if (flags & 2) {
          let parsed: z.infer<typeof trailer>;
          try { parsed = trailer.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded))); }
          catch { throw new Error("Malformed Devin Connect trailer."); }
          if (parsed.error) {
            // Do not echo upstream messages: they may contain a credential or a
            // prompt fragment. Preserve only the standard Connect status code.
            const code = /^[a-z_]{1,40}$/.test(parsed.error.code) ? parsed.error.code : "unknown";
            throw new Error(`Devin rejected the request (${code}). No retry, model or account fallback was attempted.`);
          }
          ended = true;
        } else yield decoded;
        headerRead = 0; payload = undefined; payloadRead = 0;
      }
    }
    if (!ended || headerRead || payload) throw new Error("Devin stream ended without a complete successful trailer.");
  } finally { signal?.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
