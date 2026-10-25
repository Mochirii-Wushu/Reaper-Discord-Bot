import { createHash } from "node:crypto";

const MAX_SHARDS = 16;
const UINT64_MAX = 18_446_744_073_709_551_615n;
type GoodbyeEvent = {
  guild: { id: string };
  user: { id: string; bot?: boolean };
  eventIdentity: string;
};

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value) && BigInt(value) <= UINT64_MAX;
}

function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalid(): Error {
  return new Error("Gateway goodbye context is invalid; operator reconciliation required.");
}

/** Uses raw dispatch identity without fetching or retaining a guild member roster. */
export class GatewayGoodbyes {
  #guildId: string;
  #sessions = new Map<number, string>();

  constructor(guildId: string) {
    if (!identifier(guildId)) throw invalid();
    this.#guildId = guildId;
  }

  read(packet: unknown, shardId: number): GoodbyeEvent | null {
    if (!record(packet) || packet.op !== 0 ||
      (packet.t !== "READY" && packet.t !== "GUILD_MEMBER_REMOVE")) return null;
    if (!sequence(shardId) || !record(packet.d)) throw invalid();

    if (packet.t === "READY") {
      if (!sequence(packet.s) || typeof packet.d.session_id !== "string" ||
        packet.d.session_id.length < 1 || packet.d.session_id.length > 256 ||
        (!this.#sessions.has(shardId) && this.#sessions.size >= MAX_SHARDS)) throw invalid();
      // Never retain a session ID or the original Gateway packet.
      this.#sessions.set(shardId, hash(packet.d.session_id));
      return null;
    }

    if (!identifier(packet.d.guild_id)) throw invalid();
    if (packet.d.guild_id !== this.#guildId) return null;
    if (!record(packet.d.user) || !identifier(packet.d.user.id) ||
      (packet.d.user.bot !== undefined && typeof packet.d.user.bot !== "boolean")) throw invalid();
    if (packet.d.user.bot === true) return null;
    const sessionHash = this.#sessions.get(shardId);
    if (!sessionHash || !sequence(packet.s)) throw invalid();

    return {
      guild: { id: this.#guildId },
      user: packet.d.user.bot === false ? { id: packet.d.user.id, bot: false } : { id: packet.d.user.id },
      eventIdentity: hash(`${sessionHash}\n${this.#guildId}\n${packet.d.user.id}\n${packet.s}`),
    };
  }
}
