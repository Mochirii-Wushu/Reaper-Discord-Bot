import {
  constantTimeSecretEqual,
  MAX_SHARED_SECRET_BYTES,
} from "./secret-auth.ts";

Deno.test("constant-time secret comparison is exact and bounded", () => {
  if (!constantTimeSecretEqual("synthetic-secret", "synthetic-secret")) {
    throw new Error("Equal secrets should match.");
  }
  for (const provided of ["", "synthetic-secreu", "synthetic-secret-extra"]) {
    if (constantTimeSecretEqual(provided, "synthetic-secret")) {
      throw new Error("Different or empty secrets must fail closed.");
    }
  }
  if (
    !constantTimeSecretEqual(
      "x".repeat(MAX_SHARED_SECRET_BYTES),
      "x".repeat(MAX_SHARED_SECRET_BYTES),
    )
  ) {
    throw new Error("The exact maximum credential size should match.");
  }
  if (
    constantTimeSecretEqual(
      "x".repeat(MAX_SHARED_SECRET_BYTES + 1),
      "x".repeat(MAX_SHARED_SECRET_BYTES + 1),
    )
  ) {
    throw new Error("Oversized credentials must fail closed.");
  }
});
