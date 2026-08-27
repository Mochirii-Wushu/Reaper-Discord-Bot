export const MIN_SHARED_SECRET_BYTES = 32;
export const MAX_SHARED_SECRET_BYTES = 1_024;
const encoder = new TextEncoder();

export async function constantTimeSecretEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  if (
    providedBytes.length === 0 || expectedBytes.length === 0 ||
    providedBytes.length < MIN_SHARED_SECRET_BYTES ||
    expectedBytes.length < MIN_SHARED_SECRET_BYTES ||
    providedBytes.length > MAX_SHARED_SECRET_BYTES ||
    expectedBytes.length > MAX_SHARED_SECRET_BYTES
  ) return false;

  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", providedBytes),
    crypto.subtle.digest("SHA-256", expectedBytes),
  ]);
  const providedDigest = new Uint8Array(providedHash);
  const expectedDigest = new Uint8Array(expectedHash);
  let mismatch = providedBytes.length ^ expectedBytes.length;
  for (let index = 0; index < providedDigest.length; index += 1) {
    mismatch |= providedDigest[index] ^ expectedDigest[index];
  }
  return mismatch === 0;
}
