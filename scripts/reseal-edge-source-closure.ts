import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const defaultRoot = resolve(import.meta.dir, "..");
const defaultBaseCommit = "88d06147159ba3b9ea8d62fee08e50187c394a5b";
const defaultSelfPath = "contracts/reaper-edge-source-closure.v1.json";

function gitTextAt(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function gitBytesAt(repositoryRoot: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function assertCleanSourceClosureGitState(
  repositoryRoot: string,
): void {
  const unstaged = gitBytesAt(repositoryRoot, [
    "diff",
    "--name-only",
    "-z",
    "--",
  ]);
  const untracked = gitBytesAt(repositoryRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (unstaged.byteLength !== 0 || untracked.byteLength !== 0) {
    throw new Error(
      "Source closure requires every tracked final byte staged and no untracked residue.",
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type SourceClosureResealOptions = {
  repositoryRoot?: string;
  baseCommit?: string;
  selfPath?: string;
  report?: (message: string) => void;
};

export function resealSourceClosure(
  options: SourceClosureResealOptions = {},
): void {
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRoot);
  const baseCommit = options.baseCommit ?? defaultBaseCommit;
  const selfPath = options.selfPath ?? defaultSelfPath;
  const report = options.report ?? console.log;
  assertCleanSourceClosureGitState(repositoryRoot);
  const staged = gitBytesAt(repositoryRoot, [
    "diff",
    "--cached",
    "--name-status",
    "-z",
    "--no-renames",
    baseCommit,
  ]);
  const useIndex = staged.byteLength > 0;
  const inventoryBytes = useIndex ? staged : gitBytesAt(repositoryRoot, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    baseCommit,
    "HEAD",
  ]);
  const parts = inventoryBytes.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  if (parts.length % 2 !== 0) {
    throw new Error("Invalid Git inventory framing.");
  }

  const entries = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index] as "A" | "M" | "D";
    const path = parts[index + 1];
    if (path === selfPath) continue;
    const revision = status === "D"
      ? `${baseCommit}:${path}`
      : useIndex
      ? `:${path}`
      : `HEAD:${path}`;
    const blob = gitTextAt(repositoryRoot, ["rev-parse", revision]);
    const bytes = gitBytesAt(repositoryRoot, ["cat-file", "blob", blob]);
    const modeLine = status === "D"
      ? gitTextAt(repositoryRoot, ["ls-tree", baseCommit, "--", path])
      : useIndex
      ? gitTextAt(repositoryRoot, ["ls-files", "-s", "--", path])
      : gitTextAt(repositoryRoot, ["ls-tree", "HEAD", "--", path]);
    const mode = modeLine.match(/^(\d{6})\s/u)?.[1] || "";
    entries.push({
      status,
      path,
      mode,
      blob,
      sha256: sha256(bytes),
      byteCount: bytes.byteLength,
    });
  }
  entries.sort((left, right) => left.path < right.path ? -1 : 1);
  const frame = Buffer.concat(entries.map((entry) =>
    Buffer.from(
      `${entry.status}\0${entry.path}\0${entry.mode}\0${entry.blob}\0${entry.sha256}\n`,
      "utf8",
    )
  ));
  const contract = {
    schemaVersion: 1,
    contractId: "reaper-edge-source-closure.v1",
    status: "exact-tree-source-closure",
    baseCommit,
    branch: "lifecycle-neutral",
    selfPath,
    selfExcludedFromClosure: true,
    framing:
      "rows ASCII-sorted by path; each row is status + NUL + path + NUL + mode + NUL + Git blob + NUL + lowercase SHA256(blob bytes) + LF",
    fileCount: entries.length,
    byteCount: frame.byteLength,
    sha256: sha256(frame),
    entries,
  };
  writeFileSync(
    resolve(repositoryRoot, selfPath),
    `${JSON.stringify(contract, null, 2)}\n`,
    "utf8",
  );
  report(
    `Resealed ${
      useIndex ? "index" : "HEAD"
    } source closure: ${entries.length}/${frame.byteLength}/${contract.sha256}.`,
  );
}

if (import.meta.main) resealSourceClosure();
