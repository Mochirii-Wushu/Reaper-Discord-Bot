import { resolveServiceRoleKey } from "./supabase-service-role.ts";

Deno.test("direct service role key wins unchanged", () => {
  assertEquals(
    resolveServiceRoleKey(
      "direct-placeholder",
      '{"default":"default-placeholder","service_role":"legacy-placeholder"}',
    ),
    "direct-placeholder",
  );
  assertEquals(
    resolveServiceRoleKey("  direct-placeholder  ", null),
    "  direct-placeholder  ",
  );
});

Deno.test("bundled default key wins over the legacy key", () => {
  assertEquals(
    resolveServiceRoleKey(
      "",
      '{"default":"default-placeholder","service_role":"legacy-placeholder"}',
    ),
    "default-placeholder",
  );
});

Deno.test("bundled legacy service role remains supported", () => {
  assertEquals(
    resolveServiceRoleKey(null, '{"service_role":"legacy-placeholder"}'),
    "legacy-placeholder",
  );
  assertEquals(
    resolveServiceRoleKey(
      undefined,
      '{"default":"","service_role":"legacy-placeholder"}',
    ),
    "legacy-placeholder",
  );
});

Deno.test("missing or unusable service role values fail closed", () => {
  assertEquals(resolveServiceRoleKey("", null), "");
  assertEquals(resolveServiceRoleKey(undefined, ""), "");
  assertEquals(resolveServiceRoleKey(null, "not-json"), "");
  assertEquals(resolveServiceRoleKey(null, "null"), "");
  assertEquals(resolveServiceRoleKey(null, "[]"), "");
  assertEquals(resolveServiceRoleKey(null, '"string"'), "");
  assertEquals(resolveServiceRoleKey(null, "42"), "");
  assertEquals(resolveServiceRoleKey(null, "{}"), "");
});

Deno.test("truthy bundled values preserve string conversion", () => {
  assertEquals(resolveServiceRoleKey(null, '{"default":123}'), "123");
  assertEquals(
    resolveServiceRoleKey(null, '{"default":0,"service_role":456}'),
    "456",
  );
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}
