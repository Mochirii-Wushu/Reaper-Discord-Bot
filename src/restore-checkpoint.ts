import { lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ADMISSION_FILE, admissionJournalSource } from "./member-forwarder.js";
import { MAX_CHECKPOINT_BYTES, assertPrivateDirectory, parseCheckpoint, readPrivateFile, syncPrivateDirectory, writePrivateFile } from "./checkpoint.js";

/** Offline only: never initializes a client, loads runtime config, or calls a provider. */
export async function restoreCheckpoint(sourcePath: string, targetPath?: string): Promise<{ checkpointId: string; forwardingEnabled: boolean; records: number; admissionHeld: boolean; applied: boolean }> {
  if (!isAbsolute(sourcePath) || (targetPath !== undefined && !isAbsolute(targetPath))) throw new Error("Absolute offline recovery paths are required.");
  await assertPrivateDirectory(dirname(sourcePath));
  const checkpoint = parseCheckpoint(await readPrivateFile(sourcePath, MAX_CHECKPOINT_BYTES));
  if (targetPath !== undefined) {
    if (!checkpoint.forwardingEnabled) throw new Error("A disabled checkpoint cannot initialize an enabled forwarding queue.");
    await assertPrivateDirectory(dirname(targetPath));
    // A newly created directory gives this operation exclusive ownership. Existing
    // directories, including empty ones, require a different fresh staging path.
    try { await lstat(targetPath); throw new Error("Restore target already exists; use a fresh offline staging directory."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(targetPath, { mode: 0o700 });
    await assertPrivateDirectory(targetPath);
    if ((await readdir(targetPath)).length) throw new Error("Restore target is not empty.");
    // Never adopt a failed staging target. After this initial hold is durable,
    // record-write failures retain that hold and the partial restore evidence.
    await writePrivateFile(join(targetPath, ADMISSION_FILE), admissionJournalSource(true));
    await syncPrivateDirectory(targetPath);
    for (const entry of checkpoint.entries) {
      await writePrivateFile(join(targetPath, entry.filename), JSON.stringify(entry.record) + "\n");
    }
    await syncPrivateDirectory(targetPath);
    if (!checkpoint.admissionHeld) {
      const temporary = join(targetPath, `.restore-admission-${randomUUID()}.tmp`);
      let written = false;
      try {
        await writePrivateFile(temporary, admissionJournalSource(false)); written = true;
        await rename(temporary, join(targetPath, ADMISSION_FILE)); written = false;
        await syncPrivateDirectory(targetPath);
      } finally { if (written) await unlink(temporary); }
    }
    await syncPrivateDirectory(dirname(targetPath));
  }
  return { checkpointId: checkpoint.checkpointId, forwardingEnabled: checkpoint.forwardingEnabled, records: checkpoint.entries.length,
    admissionHeld: checkpoint.admissionHeld, applied: targetPath !== undefined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (!(args.length === 1 || (args.length === 3 && args[1] === "--apply"))) throw new Error("Usage: restore-checkpoint <absolute-checkpoint> [--apply <fresh-offline-directory>]");
    const result = await restoreCheckpoint(args[0]!, args[2]);
    // Only checkpoint metadata, never member identities, records or bodies.
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch {
    console.error("Offline checkpoint validation or restore failed; preserve evidence and reconcile.");
    process.exitCode = 1;
  }
}
