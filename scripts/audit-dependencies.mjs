import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const policyPath = resolve(root, "security/dependency-audit-exceptions.v1.json");

const exceptionKeys = [
  "advisoryUrl",
  "approvedAtUtc",
  "approvedBy",
  "compensatingControls",
  "expiresAtUtc",
  "owner",
  "package",
  "reachability",
  "reason",
  "scope",
  "trackingUrl",
  "vulnerableVersions",
];

const severityRank = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);
const maximumAuditBytes = 2 * 1024 * 1024;
const packagePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/;
const advisoryUrlPattern = /^https:\/\/github\.com\/advisories\/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

const canonicalTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

function boundedText(value, name, maximumLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be nonempty, bounded text without control characters.`);
  }
}

function canonicalTime(value, name) {
  boundedText(value, name, 20);
  if (!canonicalTimePattern.test(value)) throw new Error(`${name} must be canonical UTC seconds.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace("Z", ".000Z")) {
    throw new Error(`${name} must be a real canonical UTC instant.`);
  }
  return milliseconds;
}

function exactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${name} has missing or unknown fields.`);
}

export function validateAuditPolicy(policy, nowMs = Date.now()) {
  exactKeys(policy, ["exceptions", "maximumExceptionDays", "schemaVersion", "severityThreshold"], "policy");
  if (policy.schemaVersion !== 1) throw new Error("policy.schemaVersion must equal 1.");
  if (policy.severityThreshold !== "high") throw new Error("policy.severityThreshold must equal high.");
  if (policy.maximumExceptionDays !== 30) throw new Error("policy.maximumExceptionDays must equal 30.");
  if (!Array.isArray(policy.exceptions)) throw new Error("policy.exceptions must be an array.");

  const seen = new Set();
  for (const [index, exception] of policy.exceptions.entries()) {
    const name = `policy.exceptions[${index}]`;
    exactKeys(exception, exceptionKeys, name);
    boundedText(exception.package, `${name}.package`, 160);
    if (!packagePattern.test(exception.package)) throw new Error(`${name}.package must be an exact registry package name.`);
    boundedText(exception.vulnerableVersions, `${name}.vulnerableVersions`, 160);
    boundedText(exception.advisoryUrl, `${name}.advisoryUrl`, 160);
    if (!advisoryUrlPattern.test(exception.advisoryUrl)) throw new Error(`${name}.advisoryUrl must be an exact GitHub advisory URL.`);
    const findingKey = `${exception.package}\u0000${exception.advisoryUrl}\u0000${exception.vulnerableVersions}`;
    if (seen.has(findingKey)) throw new Error(`${name} duplicates an exact package advisory.`);
    seen.add(findingKey);
    boundedText(exception.reason, `${name}.reason`, 600);
    boundedText(exception.reachability, `${name}.reachability`, 600);
    boundedText(exception.compensatingControls, `${name}.compensatingControls`, 600);
    boundedText(exception.owner, `${name}.owner`, 120);
    boundedText(exception.approvedBy, `${name}.approvedBy`, 120);
    if (!["production", "development", "both"].includes(exception.scope)) throw new Error(`${name}.scope is invalid.`);

    let trackingUrl;
    try {
      trackingUrl = new URL(exception.trackingUrl);
    } catch {
      throw new Error(`${name}.trackingUrl must be an absolute URL.`);
    }
    if (trackingUrl.protocol !== "https:" || trackingUrl.username || trackingUrl.password || trackingUrl.hash) {
      throw new Error(`${name}.trackingUrl must be credential-free HTTPS without a fragment.`);
    }

    const approvedAtMs = canonicalTime(exception.approvedAtUtc, `${name}.approvedAtUtc`);
    const expiresAtMs = canonicalTime(exception.expiresAtUtc, `${name}.expiresAtUtc`);
    const maximumDurationMs = policy.maximumExceptionDays * 24 * 60 * 60 * 1000;
    if (approvedAtMs > nowMs) throw new Error(`${name}.approvedAtUtc cannot be in the future.`);
    if (expiresAtMs <= nowMs) throw new Error(`${name} is expired.`);
    if (expiresAtMs <= approvedAtMs || expiresAtMs - approvedAtMs > maximumDurationMs) {
      throw new Error(`${name} exceeds the maximum exception duration.`);
    }
  }

  return policy;
}

export function auditArguments(scope) {
  if (!["production", "complete"].includes(scope)) throw new Error("Audit scope must be production or complete.");
  return [
    "audit",
    "--json",
    ...(scope === "production" ? ["--prod"] : []),
    "--audit-level=high",
  ];
}

function validateFinding(packageName, finding, index) {
  const name = `audit.${packageName}[${index}]`;
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) throw new Error(`${name} must be an object.`);
  if (!Number.isSafeInteger(finding.id) || finding.id < 1) throw new Error(`${name}.id must be a positive safe integer.`);
  boundedText(finding.url, `${name}.url`, 160);
  if (!advisoryUrlPattern.test(finding.url)) throw new Error(`${name}.url must be an exact GitHub advisory URL.`);
  boundedText(finding.title, `${name}.title`, 600);
  boundedText(finding.severity, `${name}.severity`, 16);
  if (!severityRank.has(finding.severity)) throw new Error(`${name}.severity is invalid.`);
  boundedText(finding.vulnerable_versions, `${name}.vulnerable_versions`, 160);
  return {
    advisoryUrl: finding.url,
    id: finding.id,
    package: packageName,
    severity: finding.severity,
    title: finding.title,
    vulnerableVersions: finding.vulnerable_versions,
  };
}

export function parseAuditReport(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maximumAuditBytes) {
    throw new Error("Dependency audit JSON must be text no larger than 2 MiB.");
  }
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error("Dependency audit output must be valid JSON.");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error("Dependency audit report must be an object.");

  const findings = [];
  for (const packageName of Object.keys(report).sort()) {
    if (!packagePattern.test(packageName)) throw new Error(`Audit package key ${packageName} is invalid.`);
    const advisories = report[packageName];
    if (!Array.isArray(advisories) || advisories.length < 1 || advisories.length > 1024) {
      throw new Error(`Audit package ${packageName} must contain 1..1024 advisories.`);
    }
    for (const [index, finding] of advisories.entries()) findings.push(validateFinding(packageName, finding, index));
  }
  if (findings.length > 4096) throw new Error("Dependency audit report exceeds 4096 advisories.");
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return findings.sort((left, right) =>
    compare(left.package, right.package) ||
    compare(left.advisoryUrl, right.advisoryUrl) ||
    compare(left.vulnerableVersions, right.vulnerableVersions));
}

function exceptionApplies(exception, scope) {
  return scope === "complete" || exception.scope === "production" || exception.scope === "both";
}

function findingKey(value) {
  return `${value.package}\u0000${value.advisoryUrl}\u0000${value.vulnerableVersions}`;
}

export function evaluateAuditReport(findings, policy, scope) {
  if (!["production", "complete"].includes(scope)) throw new Error("Audit scope must be production or complete.");
  const threshold = severityRank.get(policy.severityThreshold);
  const blocking = findings.filter((finding) => severityRank.get(finding.severity) >= threshold);
  const applicableExceptions = policy.exceptions.filter((exception) => exceptionApplies(exception, scope));
  const approvedKeys = new Set(applicableExceptions.map(findingKey));
  const findingKeys = new Set(blocking.map(findingKey));
  return {
    unapproved: blocking.filter((finding) => !approvedKeys.has(findingKey(finding))),
    unusedExceptions: applicableExceptions.filter((exception) => !findingKeys.has(findingKey(exception))),
  };
}

export function loadAuditPolicy(path = policyPath, nowMs = Date.now()) {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Dependency audit policy exceeds 64 KiB.");
  return validateAuditPolicy(JSON.parse(text), nowMs);
}

function main(argv) {
  const checkPolicy = argv.length === 1 && argv[0] === "--check-policy";
  const scopeArgument = argv.length === 1 ? argv[0].match(/^--scope=(production|complete)$/) : null;
  if (!checkPolicy && !scopeArgument) throw new Error("Use --check-policy or --scope=production|complete.");

  const policy = loadAuditPolicy();
  if (checkPolicy) {
    console.log("Reaper dependency audit policy passed.");
    return;
  }

  const scope = scopeArgument[1];
  const result = spawnSync("bun", auditArguments(scope), {
    encoding: "utf8",
    maxBuffer: maximumAuditBytes,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`bun audit terminated by ${result.signal}.`);
  if (result.status !== 0 && result.status !== 1) throw new Error(`bun audit failed with status ${result.status ?? "unknown"}.`);
  const findings = parseAuditReport(result.stdout);
  const evaluation = evaluateAuditReport(findings, policy, scope);
  for (const finding of evaluation.unapproved) {
    console.error(`- ${finding.severity} ${finding.package} ${finding.vulnerableVersions} ${finding.advisoryUrl}`);
  }
  for (const exception of evaluation.unusedExceptions) {
    console.error(`- stale exception ${exception.package} ${exception.vulnerableVersions} ${exception.advisoryUrl}`);
  }
  if (evaluation.unapproved.length || evaluation.unusedExceptions.length) {
    process.exitCode = 1;
  } else {
    console.log(`Reaper ${scope} dependency audit passed.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
