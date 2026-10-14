// Wire tags follow the pinned WindsurfAPI Connect implementation; see notices.
import { MAX_BYTES } from "./constants.ts";

export type Field = { tag: number; wire: 0; value: bigint } |
  { tag: number; wire: 1 | 2 | 5; value: Buffer };

export function varint(value: bigint | number): Buffer {
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error("Protobuf integer is out of range.");
  const bytes: number[] = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}

function key(tag: number, wire: number): Buffer {
  if (!Number.isInteger(tag) || tag < 1 || tag > 0x1fffffff) throw new Error("Invalid protobuf tag.");
  return varint(BigInt(tag) * 8n + BigInt(wire));
}

export const integer = (tag: number, value: bigint | number) => Buffer.concat([key(tag, 0), varint(value)]);
export function bytes(tag: number, value: Uint8Array): Buffer {
  if (value.byteLength > MAX_BYTES) throw new Error("Protobuf field exceeds the size limit.");
  return Buffer.concat([key(tag, 2), varint(value.byteLength), value]);
}
export const text = (tag: number, value: string) => bytes(tag, Buffer.from(value, "utf8"));
export function double(tag: number, value: number): Buffer {
  if (!Number.isFinite(value)) throw new Error("Invalid protobuf floating-point value.");
  const raw = Buffer.alloc(8); raw.writeDoubleLE(value);
  return Buffer.concat([key(tag, 1), raw]);
}

export function fields(raw: Uint8Array): Field[] {
  if (raw.byteLength > MAX_BYTES) throw new Error("Protobuf message exceeds the size limit.");
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  let offset = 0;
  const readInteger = () => {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (offset >= buffer.length) throw new Error("Truncated protobuf integer.");
      const byte = buffer[offset++];
      if (index === 9 && byte > 1) throw new Error("Oversized protobuf integer.");
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error("Oversized protobuf integer.");
  };
  const output: Field[] = [];
  while (offset < buffer.length) {
    if (output.length >= 100_000) throw new Error("Too many protobuf fields.");
    const header = readInteger();
    const tag = Number(header >> 3n), wire = Number(header & 7n);
    if (tag < 1 || tag > 0x1fffffff) throw new Error("Invalid protobuf tag.");
    if (wire === 0) { output.push({ tag, wire, value: readInteger() }); continue; }
    if (wire !== 1 && wire !== 2 && wire !== 5) throw new Error("Unsupported protobuf wire type.");
    const length = wire === 2 ? Number(readInteger()) : wire === 1 ? 8 : 4;
    if (!Number.isSafeInteger(length) || length > MAX_BYTES || offset + length > buffer.length) {
      throw new Error("Truncated or oversized protobuf field.");
    }
    output.push({ tag, wire, value: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  return output;
}

export function message(source: Field[], tag: number): Buffer | undefined {
  const matched = source.filter((field) => field.tag === tag);
  if (matched.length > 1 || (matched[0] && matched[0].wire !== 2)) throw new Error("Invalid singular protobuf message.");
  const field = matched[0];
  return field?.wire === 2 ? field.value : undefined;
}
export function string(source: Field[], tag: number): string | undefined {
  const value = message(source, tag);
  return value === undefined ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(value);
}
export function number(source: Field[], tag: number): number | undefined {
  const matched = source.filter((field) => field.tag === tag);
  if (matched.length > 1 || (matched[0] && matched[0].wire !== 0)) throw new Error("Invalid singular protobuf integer.");
  const field = matched[0];
  if (field?.wire !== 0) return undefined;
  if (field.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Protobuf integer exceeds the safe range.");
  return Number(field.value);
}
