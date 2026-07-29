import nacl from "tweetnacl";

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    output[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return output;
}

export function verifyDiscordSignature(
  req: Request,
  rawBody: string | Uint8Array,
  publicKey: string,
  nowMs = Date.now(),
): boolean {
  const signatureHeader = req.headers.get("x-signature-ed25519") || "";
  const timestampHeader = req.headers.get("x-signature-timestamp") || "";
  const signature = hexToBytes(signatureHeader);
  const key = hexToBytes(publicKey);
  const timestampMs = Number(timestampHeader) * 1000;

  if (
    !signature || signature.length !== 64 || !key || key.length !== 32 ||
    !Number.isFinite(timestampMs)
  ) {
    return false;
  }

  if (Math.abs(nowMs - timestampMs) > SIGNATURE_WINDOW_MS) {
    return false;
  }

  const encoder = new TextEncoder();
  const timestamp = encoder.encode(timestampHeader);
  const body = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const message = new Uint8Array(timestamp.byteLength + body.byteLength);
  message.set(timestamp);
  message.set(body, timestamp.byteLength);
  return nacl.sign.detached.verify(message, signature, key);
}
