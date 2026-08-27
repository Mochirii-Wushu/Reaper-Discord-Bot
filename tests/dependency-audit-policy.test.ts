import { describe, expect, test } from "bun:test";
import {
  auditArguments,
  evaluateAuditReport,
  parseAuditReport,
  validateAuditPolicy,
} from "../scripts/audit-dependencies.mjs";

const now = Date.parse("2026-08-09T12:00:00Z");

function exception(overrides: Record<string, unknown> = {}) {
  return {
    advisoryUrl: "https://github.com/advisories/GHSA-2345-6789-cfgh",
    approvedAtUtc: "2026-08-01T00:00:00Z",
    approvedBy: "security-owner",
    compensatingControls: "The affected path is disabled and monitored.",
    expiresAtUtc: "2026-08-20T00:00:00Z",
    owner: "runtime-owner",
    package: "example-package",
    reachability: "The vulnerable API is not called by the Gateway worker.",
    reason: "No compatible fixed release exists yet.",
    scope: "production",
    trackingUrl: "https://github.com/Mochirii-Wushu/Reaper-Discord-Bot/security/advisories/GHSA-example",
    vulnerableVersions: ">=1.0.0 <1.0.2",
    ...overrides,
  };
}

function policy(exceptions: unknown[] = []) {
  return {
    schemaVersion: 1,
    severityThreshold: "high",
    maximumExceptionDays: 30,
    exceptions,
  };
}

describe("dependency audit policy", () => {
  test("accepts an empty fail-closed policy", () => {
    expect(validateAuditPolicy(policy(), now).exceptions).toEqual([]);
  });

  test("builds separate production and complete graph audits", () => {
    expect(auditArguments("production")).toEqual(["audit", "--json", "--prod", "--audit-level=high"]);
    expect(auditArguments("complete")).toEqual(["audit", "--json", "--audit-level=high"]);
  });

  test("rejects threshold, schema, unknown-field, and duplicate drift", () => {
    expect(() => validateAuditPolicy({ ...policy(), severityThreshold: "moderate" }, now)).toThrow();
    expect(() => validateAuditPolicy({ ...policy(), extra: true }, now)).toThrow();
    expect(() => validateAuditPolicy(policy([{ ...exception(), extra: true }]), now)).toThrow();
    expect(() => validateAuditPolicy(policy([exception(), exception()]), now)).toThrow();
  });

  test("rejects expired, future, noncanonical, and overlong exceptions", () => {
    expect(() => validateAuditPolicy(policy([exception({ expiresAtUtc: "2026-08-09T12:00:00Z" })]), now)).toThrow();
    expect(() => validateAuditPolicy(policy([exception({ approvedAtUtc: "2026-08-10T00:00:00Z" })]), now)).toThrow();
    expect(() => validateAuditPolicy(policy([exception({ approvedAtUtc: "2026-08-01T00:00:00.000Z" })]), now)).toThrow();
    expect(() => validateAuditPolicy(policy([exception({ expiresAtUtc: "2026-09-15T00:00:00Z" })]), now)).toThrow();
  });

  test("rejects weak scope and tracking bindings", () => {
    expect(() => validateAuditPolicy(policy([exception({ scope: "all" })]), now)).toThrow();
    expect(() => validateAuditPolicy(policy([exception({ trackingUrl: "http://example.com/finding" })]), now)).toThrow();
    expect(() => validateAuditPolicy(policy([exception({ trackingUrl: "https://user:secret@example.com/finding" })]), now)).toThrow();
  });

  test("parses bounded Bun audit JSON and binds exceptions to package, advisory, and range", () => {
    const findings = parseAuditReport(JSON.stringify({
      "example-package": [{
        id: 12345,
        url: "https://github.com/advisories/GHSA-2345-6789-cfgh",
        title: "Synthetic high advisory",
        severity: "high",
        vulnerable_versions: ">=1.0.0 <1.0.2",
      }],
      "other-package": [{
        id: 54321,
        url: "https://github.com/advisories/GHSA-2345-6789-cfgh",
        title: "Same advisory on another package",
        severity: "high",
        vulnerable_versions: "<2.0.0",
      }],
    }));
    const validated = validateAuditPolicy(policy([exception()]), now);
    const result = evaluateAuditReport(findings, validated, "production");
    expect(result.unapproved.map((finding) => finding.package)).toEqual(["other-package"]);
    expect(result.unusedExceptions).toEqual([]);
    expect(evaluateAuditReport(findings, validateAuditPolicy(policy([
      exception({ vulnerableVersions: "<9.0.0" }),
    ]), now), "production").unapproved).toHaveLength(2);
  });

  test("fails closed on malformed reports and stale exceptions", () => {
    expect(() => parseAuditReport("[]")).toThrow();
    expect(() => parseAuditReport(JSON.stringify({ "bad name": [{}] }))).toThrow();
    expect(() => parseAuditReport("x".repeat(2 * 1024 * 1024 + 1))).toThrow();
    const validated = validateAuditPolicy(policy([exception()]), now);
    expect(evaluateAuditReport([], validated, "production").unusedExceptions).toEqual(validated.exceptions);
  });
});
