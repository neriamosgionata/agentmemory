// The pinned engine rejects WebSocket frames over 16 MiB; an oversized
// function result drops the worker and 404s every endpoint. Refuse the
// payload as one clean error instead. The cap sits under the frame limit
// to leave headroom for the SDK's framing overhead.
const FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
export const SAFE_PAYLOAD_BYTES = 15 * 1024 * 1024;

export type OversizedPayload = {
  success: false;
  error: string;
  oversized: true;
  bytes: number;
  limitBytes: number;
};

// Exact JSON byte length without ever materialising the whole document as
// one string. `JSON.stringify(payload)` on a large export held the entire
// serialized copy (and its transient intermediates) in memory — the #1334
// 18.5 GB RSS report — so walk the value leaf-by-leaf instead. The result
// matches JSON.stringify's UTF-8 length: keys are quoted, undefined object
// members are skipped, undefined array items become null, and separators
// are counted.
export function payloadByteLength(payload: unknown): number {
  const seen = new Set<object>();

  function walk(value: unknown, inArray: boolean): number {
    if (value === undefined) return inArray ? 4 : 0;
    if (value === null) return 4;
    const type = typeof value;
    if (type === "string") {
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    }
    if (type === "number" || type === "boolean") {
      const encoded = JSON.stringify(value);
      return encoded === undefined ? 0 : Buffer.byteLength(encoded, "utf8");
    }
    if (type === "bigint") {
      throw new TypeError("Do not know how to serialize a BigInt");
    }
    if (type === "object") {
      const obj = value as object;
      if (seen.has(obj)) {
        throw new TypeError("Converting circular structure to JSON");
      }
      seen.add(obj);
      let bytes: number;
      if (Array.isArray(obj)) {
        bytes = 2;
        for (let i = 0; i < obj.length; i++) {
          bytes += walk(obj[i], true) + (i > 0 ? 1 : 0);
        }
      } else {
        bytes = 2;
        let first = true;
        for (const [key, member] of Object.entries(obj)) {
          if (member === undefined) continue;
          bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
          if (!first) bytes += 1;
          first = false;
          bytes += walk(member, false);
        }
      }
      seen.delete(obj);
      return bytes;
    }
    // function/symbol: omitted in objects, null in arrays.
    return inArray ? 4 : 0;
  }

  return walk(payload, false);
}

export function oversizedPayloadError(
  bytes: number,
  hint: string,
): OversizedPayload {
  const mib = (bytes / (1024 * 1024)).toFixed(1);
  return {
    success: false,
    error: `Response is ${mib} MiB, over the ~${SAFE_PAYLOAD_BYTES / (1024 * 1024)} MiB engine transport frame limit; ${hint}`,
    oversized: true,
    bytes,
    limitBytes: SAFE_PAYLOAD_BYTES,
  };
}

// Serializes once; callers that also return the payload pay a second
// serialization, acceptable on these cold export paths.
export function checkPayloadFrameSize(
  payload: unknown,
  hint: string,
): OversizedPayload | null {
  const bytes = payloadByteLength(payload);
  if (bytes <= SAFE_PAYLOAD_BYTES) return null;
  return oversizedPayloadError(bytes, hint);
}

export const FRAME_LIMIT_BYTES_FOR_TEST = FRAME_LIMIT_BYTES;
