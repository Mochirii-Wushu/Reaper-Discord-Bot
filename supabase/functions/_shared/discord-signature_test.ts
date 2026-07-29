import nacl from "tweetnacl";
import { hexToBytes, verifyDiscordSignature } from "./discord-signature.ts";

const encoder = new TextEncoder();

Deno.test("Discord signature helper accepts a valid raw-body signature", () => {
  const keyPair = nacl.sign.keyPair();
  const timestamp = "1780000000";
  const rawBody = JSON.stringify({ type: 1 });
  const message = encoder.encode(`${timestamp}${rawBody}`);
  const signature = nacl.sign.detached(message, keyPair.secretKey);
  const req = signedRequest(timestamp, bytesToHex(signature));

  assert(
    verifyDiscordSignature(
      req,
      rawBody,
      bytesToHex(keyPair.publicKey),
      Number(timestamp) * 1000,
    ),
    "valid signature should pass",
  );
  assert(
    verifyDiscordSignature(
      req,
      encoder.encode(rawBody),
      bytesToHex(keyPair.publicKey),
      Number(timestamp) * 1000,
    ),
    "valid byte-preserving signature should pass",
  );
});

Deno.test("Discord signature helper rejects stale timestamps and malformed signatures", () => {
  const keyPair = nacl.sign.keyPair();
  const timestamp = "1780000000";
  const rawBody = JSON.stringify({ type: 1 });
  const message = encoder.encode(`${timestamp}${rawBody}`);
  const signature = nacl.sign.detached(message, keyPair.secretKey);

  assert(
    verifyDiscordSignature(
      signedRequest(timestamp, bytesToHex(signature)),
      rawBody,
      bytesToHex(keyPair.publicKey),
      Number(timestamp) * 1000 + 1_000_000,
    ) === false,
    "stale timestamp should fail",
  );
  assert(
    verifyDiscordSignature(
      signedRequest(timestamp, "not-hex"),
      rawBody,
      bytesToHex(keyPair.publicKey),
      Number(timestamp) * 1000,
    ) === false,
    "malformed signature should fail",
  );
});

Deno.test("hexToBytes validates hex input", () => {
  const bytes = hexToBytes("0a10ff");
  assert(bytes?.length === 3, "valid hex should decode");
  assert(hexToBytes("0xz") === null, "invalid hex should reject");
  assert(hexToBytes("abc") === null, "odd-length hex should reject");
});

function signedRequest(timestamp: string, signature: string): Request {
  return new Request("https://example.invalid", {
    method: "POST",
    headers: {
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
