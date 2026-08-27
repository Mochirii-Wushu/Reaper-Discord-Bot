import {
  constantTimeSecretEqual,
  MAX_SHARED_SECRET_BYTES,
  MIN_SHARED_SECRET_BYTES,
} from "./secret-auth.ts";

Deno.test("constant-time secret comparison is exact and bounded", async () => {
  const validSecret = "s".repeat(MIN_SHARED_SECRET_BYTES);
  if (!await constantTimeSecretEqual(validSecret, validSecret)) {
    throw new Error("Equal secrets should match.");
  }
  for (const provided of ["", "short", `${validSecret}x`]) {
    if (await constantTimeSecretEqual(provided, validSecret)) {
      throw new Error("Different or empty secrets must fail closed.");
    }
  }
  if (
    !await constantTimeSecretEqual(
      "x".repeat(MAX_SHARED_SECRET_BYTES),
      "x".repeat(MAX_SHARED_SECRET_BYTES),
    )
  ) {
    throw new Error("The exact maximum credential size should match.");
  }
  if (
    await constantTimeSecretEqual(
      "x".repeat(MAX_SHARED_SECRET_BYTES + 1),
      "x".repeat(MAX_SHARED_SECRET_BYTES + 1),
    )
  ) {
    throw new Error("Oversized credentials must fail closed.");
  }
});
