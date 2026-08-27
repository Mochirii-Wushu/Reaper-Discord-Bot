import {
  parseJsonNoDuplicateKeys,
  parseJsonObjectNoDuplicateKeys,
  StrictJsonError,
} from "./strict-json.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rejects(value: string): boolean {
  try {
    parseJsonNoDuplicateKeys(value);
    return false;
  } catch (error) {
    return error instanceof StrictJsonError;
  }
}

Deno.test("strict JSON accepts ordinary nested JSON", () => {
  const value = parseJsonObjectNoDuplicateKeys(
    '{"action":"sync","nested":{"roles":["synthetic"]}}',
  );
  assert(value.action === "sync", "the object should parse");
});

Deno.test("strict JSON rejects duplicate keys at every object depth", () => {
  for (
    const value of [
      '{"role":"one","role":"two"}',
      '{"outer":{"role":"one","role":"two"}}',
      '[{"role":"one","role":"two"}]',
      '{"role":"one","r\\u006fle":"two"}',
      '{"nested":{"a":1,"\\u0061":2}}',
    ]
  ) {
    assert(rejects(value), `duplicate-key input must fail closed: ${value}`);
  }
});

Deno.test("strict JSON rejects malformed, oversized, and over-deep input", () => {
  assert(rejects('{"a":1,}'), "trailing commas must fail");
  assert(rejects('{"a":01}'), "invalid numbers must fail");
  let oversized = false;
  try {
    parseJsonNoDuplicateKeys('{"a":"12345"}', { maximumBytes: 8 });
  } catch (error) {
    oversized = error instanceof StrictJsonError;
  }
  assert(oversized, "the byte ceiling must fail closed");

  let tooDeep = false;
  try {
    parseJsonNoDuplicateKeys("[[[0]]]", { maximumDepth: 2 });
  } catch (error) {
    tooDeep = error instanceof StrictJsonError;
  }
  assert(tooDeep, "the nesting ceiling must fail closed");
});
