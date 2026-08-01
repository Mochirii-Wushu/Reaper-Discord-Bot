import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const REAPER_READINESS_FILE = "/tmp/mochirii-reaper/readiness.json";
export const REAPER_READINESS_MAX_AGE_MS = 75_000;
export const REAPER_READINESS_REFRESH_MS = 25_000;

interface ReadinessRecord {
  schemaVersion: 1;
  state: "ready";
  pid: number;
  updatedAt: string;
}

interface GatewayReadinessOptions {
  filePath?: string;
  now?: () => number;
  pid?: number;
  refreshMs?: number;
}

export class GatewayReadiness {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly refreshMs: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private ready = false;

  constructor(options: GatewayReadinessOptions = {}) {
    this.filePath = options.filePath ?? REAPER_READINESS_FILE;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.refreshMs = options.refreshMs ?? REAPER_READINESS_REFRESH_MS;
  }

  async initialize(): Promise<void> {
    await this.markNotReady();
    this.refreshTimer = setInterval(() => {
      if (!this.ready) return;
      void this.persist().catch(() => {
        this.ready = false;
      });
    }, this.refreshMs);
    this.refreshTimer.unref();
  }

  async markReady(): Promise<void> {
    this.ready = true;
    await this.persist();
  }

  async markNotReady(): Promise<void> {
    this.ready = false;
    await rm(this.filePath, { force: true });
  }

  async close(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    await this.markNotReady();
  }

  private async persist(): Promise<void> {
    const record: ReadinessRecord = {
      schemaVersion: 1,
      state: "ready",
      pid: this.pid,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const temporaryPath = `${this.filePath}.${this.pid}.tmp`;

    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

export async function assertRuntimeReady(
  filePath = REAPER_READINESS_FILE,
  now = Date.now(),
  maxAgeMs = REAPER_READINESS_MAX_AGE_MS,
): Promise<void> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<ReadinessRecord>;
  const updatedAt = Date.parse(String(value.updatedAt ?? ""));

  if (
    value.schemaVersion !== 1
    || value.state !== "ready"
    || !Number.isInteger(value.pid)
    || Number(value.pid) < 1
    || !Number.isFinite(updatedAt)
    || now - updatedAt < 0
    || now - updatedAt > maxAgeMs
  ) {
    throw new Error("Reaper Gateway readiness is unavailable.");
  }

  process.kill(Number(value.pid), 0);
}
