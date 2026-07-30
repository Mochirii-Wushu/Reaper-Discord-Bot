import { rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type GatewayHealthStatus =
  | "starting"
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "error"
  | "shutting_down";

export type GatewayHealthDocument = {
  schemaVersion: 1;
  status: GatewayHealthStatus;
  observedAt: string;
  sequence: number;
  resumeCount: number;
};

type HealthWriter = (path: string, body: string) => Promise<void>;
type Clock = () => Date;

const VALID_STATUSES = new Set<GatewayHealthStatus>([
  "starting",
  "ready",
  "reconnecting",
  "disconnected",
  "error",
  "shutting_down",
]);

function parseHeartbeatMs(value: string | undefined): number {
  const normalized = String(value || "").trim();
  if (!normalized) return 30_000;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 15_000 || parsed > 300_000) {
    throw new Error(
      "REAPER_HEALTH_HEARTBEAT_MS must be an integer from 15000 through 300000.",
    );
  }
  return parsed;
}

async function atomicPrivateWrite(path: string, body: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export class RuntimeHealthReporter {
  readonly heartbeatMs: number;
  readonly path: string;

  #clock: Clock;
  #currentStatus: GatewayHealthStatus = "starting";
  #resumeCount = 0;
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();
  #writer: HealthWriter;

  constructor(options: {
    path?: string;
    heartbeatMs?: number;
    clock?: Clock;
    writer?: HealthWriter;
  } = {}) {
    this.path = String(options.path || "").trim();
    if (this.path && !isAbsolute(this.path)) {
      throw new Error("REAPER_HEALTH_STATE_PATH must be an absolute path.");
    }
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    if (
      !Number.isInteger(this.heartbeatMs) ||
      this.heartbeatMs < 15_000 ||
      this.heartbeatMs > 300_000
    ) {
      throw new Error("Gateway health heartbeat must be 15000 through 300000.");
    }
    this.#clock = options.clock || (() => new Date());
    this.#writer = options.writer || atomicPrivateWrite;
  }

  get enabled(): boolean {
    return Boolean(this.path);
  }

  publish(status: GatewayHealthStatus): Promise<void> {
    if (!VALID_STATUSES.has(status)) {
      return Promise.reject(new Error("Unsupported gateway health status."));
    }
    this.#currentStatus = status;
    if (!this.enabled) return Promise.resolve();

    this.#tail = this.#tail.then(async () => {
      this.#sequence += 1;
      const document: GatewayHealthDocument = {
        schemaVersion: 1,
        status: this.#currentStatus,
        observedAt: this.#clock().toISOString(),
        sequence: this.#sequence,
        resumeCount: this.#resumeCount,
      };
      await this.#writer(this.path, `${JSON.stringify(document)}\n`);
    });
    return this.#tail;
  }

  heartbeat(): Promise<void> {
    return this.publish(this.#currentStatus);
  }

  resumed(): Promise<void> {
    this.#resumeCount += 1;
    return this.publish("ready");
  }
}

export function createRuntimeHealthReporter(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeHealthReporter {
  return new RuntimeHealthReporter({
    path: env.REAPER_HEALTH_STATE_PATH,
    heartbeatMs: parseHeartbeatMs(env.REAPER_HEALTH_HEARTBEAT_MS),
  });
}

export function validateGatewayHealthDocument(
  value: unknown,
): GatewayHealthDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gateway health document must be an object.");
  }
  const candidate = value as Partial<GatewayHealthDocument>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.status !== "string" ||
    !VALID_STATUSES.has(candidate.status as GatewayHealthStatus) ||
    typeof candidate.observedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.observedAt)) ||
    !Number.isInteger(candidate.sequence) ||
    Number(candidate.sequence) < 1 ||
    !Number.isInteger(candidate.resumeCount) ||
    Number(candidate.resumeCount) < 0
  ) {
    throw new Error("Gateway health document is malformed.");
  }
  return candidate as GatewayHealthDocument;
}
