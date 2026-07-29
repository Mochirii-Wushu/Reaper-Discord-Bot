import { readBoundedUtf8RequestBody } from "./bounded-request-body.ts";

const encoder = new TextEncoder();

Deno.test("bounded request body accepts exact UTF-8 bytes", async () => {
  const body = '{"type":1}';
  const bodyBytes = encoder.encode(body).byteLength;
  const result = await readBoundedUtf8RequestBody(
    new Request("https://edge.example", {
      body,
      headers: { "Content-Length": String(bodyBytes) },
      method: "POST",
    }),
    bodyBytes,
  );

  if (!result.ok || result.text !== body) {
    throw new Error("An exact bounded UTF-8 body should be accepted.");
  }
});

Deno.test("declared oversized unsigned body fails before stream reads", async () => {
  const request = new Request("https://edge.example", {
    body: "{}",
    headers: { "Content-Length": "65537" },
    method: "POST",
  });
  const result = await readBoundedUtf8RequestBody(
    request,
    65536,
  );

  if (result.ok || result.status !== 413 || request.bodyUsed) {
    throw new Error("A declared oversized body must be rejected before read.");
  }
});

Deno.test("streamed oversized signed-looking body is cancelled", async () => {
  let cancelled = false;
  let chunk = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(controller) {
      chunk += 1;
      controller.enqueue(new Uint8Array(chunk === 1 ? 8 : 1));
    },
  });
  const result = await readBoundedUtf8RequestBody(
    new Request("https://edge.example", {
      body,
      headers: {
        "x-signature-ed25519": "00".repeat(64),
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      method: "POST",
    }),
    8,
  );

  if (result.ok || result.status !== 413 || !cancelled) {
    throw new Error(
      "A streamed oversized body must be cancelled and rejected.",
    );
  }
});

Deno.test("bounded request body rejects invalid UTF-8", async () => {
  const result = await readBoundedUtf8RequestBody(
    new Request("https://edge.example", {
      body: new Uint8Array([0xc3, 0x28]),
      method: "POST",
    }),
    8,
  );

  if (result.ok || result.reason !== "invalid-encoding") {
    throw new Error("Invalid UTF-8 must fail closed.");
  }
});
