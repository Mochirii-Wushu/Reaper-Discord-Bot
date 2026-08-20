export interface DependencyAuditException {
  advisoryUrl: string;
  approvedAtUtc: string;
  approvedBy: string;
  compensatingControls: string;
  expiresAtUtc: string;
  owner: string;
  package: string;
  reachability: string;
  reason: string;
  scope: "production" | "development" | "both";
  trackingUrl: string;
  vulnerableVersions: string;
}

export interface DependencyAuditFinding {
  advisoryUrl: string;
  id: number;
  package: string;
  severity: "info" | "low" | "moderate" | "high" | "critical";
  title: string;
  vulnerableVersions: string;
}

export interface DependencyAuditPolicy {
  schemaVersion: 1;
  severityThreshold: "high";
  maximumExceptionDays: 30;
  exceptions: DependencyAuditException[];
}

export const policyPath: string;
export function validateAuditPolicy(policy: unknown, nowMs?: number): DependencyAuditPolicy;
export function auditArguments(scope: "production" | "complete"): string[];
export function parseAuditReport(text: string): DependencyAuditFinding[];
export function evaluateAuditReport(
  findings: DependencyAuditFinding[],
  policy: DependencyAuditPolicy,
  scope: "production" | "complete",
): { unapproved: DependencyAuditFinding[]; unusedExceptions: DependencyAuditException[] };
export function loadAuditPolicy(path?: string, nowMs?: number): DependencyAuditPolicy;
