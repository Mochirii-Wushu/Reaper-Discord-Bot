import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const expectedLockfiles = [
  "supabase/functions/publish-member-spotlight-winner/deno.lock",
  "supabase/functions/reaper-discord-interactions/deno.lock",
  "supabase/functions/reaper-discord-member-sync/deno.lock",
  "supabase/functions/reaper-spinner-dispatch/deno.lock",
  "supabase/functions/send-member-spotlight-poll/deno.lock",
  "supabase/functions/send-vote-reminder/deno.lock",
].sort();

const gitFiles = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
if (gitFiles.exitCode !== 0) {
  throw new Error("Unable to enumerate the tracked Deno lock inventory.");
}
const actualLockfiles = gitFiles.stdout.toString("utf8").split("\0")
  .filter((path) => path.endsWith("/deno.lock"))
  .sort();
if (JSON.stringify(actualLockfiles) !== JSON.stringify(expectedLockfiles)) {
  throw new Error(
    "Tracked Deno lock inventory drifted; update the reviewed audit gate.",
  );
}

const closure = createHash("sha256");
for (const path of expectedLockfiles) {
  const bytes = readFileSync(resolve(root, path));
  const lock = JSON.parse(bytes.toString("utf8")) as { version?: string };
  if (lock.version !== "5") {
    throw new Error(`${path} is not the reviewed Deno lock format version 5.`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  closure.update(`${path}\0${digest}\0${bytes.byteLength}\n`, "utf8");

  const audit = Bun.spawnSync([
    "deno",
    "audit",
    "--frozen=true",
    `--lock=${path}`,
  ], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (audit.exitCode !== 0) {
    throw new Error(`Deno dependency advisory audit failed for ${path}.`);
  }
}

console.log(
  `Deno advisory audit passed for ${expectedLockfiles.length} exact lock graphs; inventory SHA-256 ${
    closure.digest("hex")
  }.`,
);
