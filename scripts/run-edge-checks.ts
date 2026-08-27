const functions = [
  "reaper-discord-interactions",
  "reaper-discord-member-sync",
  "reaper-spinner-dispatch",
  "send-vote-reminder",
  "send-member-spotlight-poll",
  "publish-member-spotlight-winner",
] as const;

for (const name of functions) {
  const directory = `supabase/functions/${name}`;
  const result = Bun.spawnSync([
    "deno",
    "check",
    "--node-modules-dir=auto",
    `--config=${directory}/deno.json`,
    `--lock=${directory}/deno.lock`,
    "--frozen=true",
    `${directory}/index.ts`,
  ], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Deno check failed for ${name}.`);
  }
}
