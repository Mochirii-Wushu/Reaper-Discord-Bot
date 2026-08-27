export type BoundedUtf8BodyResult =
  | { ok: true; bytes: Uint8Array; text: string }
  | {
    ok: false;
    reason:
      | "invalid-content-length"
      | "invalid-encoding"
      | "read-failed"
      | "too-large";
    status: 400 | 413;
  };

async function cancelQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The rejection is already fail-closed; cancellation is best-effort.
  }
}

export async function readBoundedUtf8RequestBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedUtf8BodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }

  const declaredHeader = request.headers.get("content-length");
  let declaredLength: number | null = null;
  if (declaredHeader !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declaredHeader)) {
      return { ok: false, reason: "invalid-content-length", status: 400 };
    }
    declaredLength = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredLength)) {
      return { ok: false, reason: "invalid-content-length", status: 400 };
    }
    if (declaredLength > maxBytes) {
      return { ok: false, reason: "too-large", status: 413 };
    }
  }

  if (!request.body) {
    if (declaredLength !== null && declaredLength !== 0) {
      return { ok: false, reason: "invalid-content-length", status: 400 };
    }
    return { ok: true, bytes: new Uint8Array(), text: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        await cancelQuietly(reader);
        return { ok: false, reason: "too-large", status: 413 };
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } catch {
    await cancelQuietly(reader);
    return { ok: false, reason: "read-failed", status: 400 };
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && totalBytes !== declaredLength) {
    return { ok: false, reason: "invalid-content-length", status: 400 };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      ok: true,
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { ok: false, reason: "invalid-encoding", status: 400 };
  }
}
