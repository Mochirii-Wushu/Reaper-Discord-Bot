export const MIN_SHARED_SECRET_BYTES = 32;
export const MAX_SHARED_SECRET_BYTES = 512;
const encoder = new TextEncoder();

export function constantTimeSecretEqual(
  provided: string,
  expected: string,
): boolean {
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  if (
    providedBytes.length === 0 || expectedBytes.length === 0 ||
    providedBytes.length > MAX_SHARED_SECRET_BYTES ||
    expectedBytes.length > MAX_SHARED_SECRET_BYTES
  ) return false;

  let mismatch = providedBytes.length ^ expectedBytes.length;
  const size = Math.max(providedBytes.length, expectedBytes.length);
  for (let index = 0; index < size; index += 1) {
    mismatch |= (providedBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }
  return mismatch === 0;
}
