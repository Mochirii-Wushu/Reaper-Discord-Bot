import { constantTimeSecretEqual } from "./secret-auth.ts";

Deno.test("constant-time secret comparison is exact and bounded", () => {
  if (!constantTimeSecretEqual("synthetic-secret", "synthetic-secret")) {
    throw new Error("Equal secrets should match.");
  }
  for (const provided of ["", "synthetic-secreu", "synthetic-secret-extra"]) {
    if (constantTimeSecretEqual(provided, "synthetic-secret")) {
      throw new Error("Different or empty secrets must fail closed.");
    }
  }
  if (constantTimeSecretEqual("x".repeat(1_025), "x".repeat(1_025))) {
    throw new Error("Oversized credentials must fail closed.");
  }
});
