import { createHash } from "node:crypto";
import { escapeMarkdown } from "discord.js";
import { canonicalDiscordIdentifier } from "./gallery-ingest-auth.js";
import type { NoticeJournal } from "./notice-journal.js";
import { WELCOME_DM_MESSAGE } from "./welcome.js";

type NoticeChannel = {
  id: string;
  guildId: string;
  type: number;
  canView: boolean;
  canSend: boolean;
};

export type CommunityNoticesOptions = {
  guildId: string;
  welcomeChannelId: string | null;
  spotlightChannelId: string | null;
  spotlightUrl: string | null;
  journal: Pick<NoticeJournal, "initialize" | "deliver">;
  resolveChannel: (id: string) => Promise<NoticeChannel>;
  send: (channelId: string, content: string, nonce: string) => Promise<{ id: string; channelId: string }>;
  fetch?: NoticeFetch;
  clock?: () => number;
  onFault?: () => void;
};

export type NoticeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type WelcomeMember = {
  guild: { id: string };
  user: { id: string; bot?: boolean };
  joinedTimestamp: number | null;
};

type GoodbyeMember = {
  guild: { id: string };
  user: { id: string; bot?: boolean };
  eventIdentity: string;
};

const FAILURE = "Community notice verification failed.";
const MAX_RESPONSE_BYTES = 16 * 1024;
const FUNCTION_PATH = "/functions/v1/get-current-spotlight-winner";
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function monthFor(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error(FAILURE);
  const month = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])$/u.test(month) || month.startsWith("0000")) throw new Error(FAILURE);
  return `${month}-01`;
}

function validateEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(FAILURE); }
  if (value !== url.href || value.length > 2048 || url.protocol !== "https:" ||
    url.username || url.password || url.port || url.search || url.hash ||
    value.includes("?") || value.includes("#") || url.pathname !== FUNCTION_PATH ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u.test(url.hostname) ||
    url.hostname.endsWith(".local") || url.hostname.endsWith(".localhost")) throw new Error(FAILURE);
  return value;
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  if (!signal) return reader.read();
  signal.throwIfAborted();
  return await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    const abort = () => reject(new Error(FAILURE));
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then((result) => {
      signal.removeEventListener("abort", abort); resolve(result);
    }, () => {
      signal.removeEventListener("abort", abort); reject(new Error(FAILURE));
    });
  });
}

// Bound the complete response before interpreting either public winner data or
// the provider's message acknowledgement. Endpoint-specific shape checks follow.
export async function readNoticeJsonResponse(
  response: Response,
  maximumBytes = MAX_RESPONSE_BYTES,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_RESPONSE_BYTES ||
    !/^application\/json(?:;[\t ]*charset=(?:utf-8|"utf-8"))?[\t ]*$/iu.test(response.headers.get("content-type") || "")) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(FAILURE);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(FAILURE);
  }
  if (!response.body) throw new Error(FAILURE);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) throw new Error(FAILURE);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    signal?.throwIfAborted();
    return JSON.parse(text) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new Error(FAILURE);
  } finally {
    try { reader.releaseLock(); } catch { /* A cancelled pending read may still hold its lock. */ }
  }
}

export class CommunityNotices {
  #options: CommunityNoticesOptions;
  #initialized = false;
  #stopped = false;
  #faulted = false;
  #spotlightInFlight: Promise<void> | undefined;
  #abort = new AbortController();

  constructor(options: CommunityNoticesOptions) { this.#options = options; }

  #fail(): never {
    if (!this.#faulted) {
      this.#faulted = true;
      try { this.#options.onFault?.(); } catch { /* Never expose a callback error. */ }
    }
    throw new Error(FAILURE);
  }

  #admitted(): void {
    if (!this.#initialized || this.#faulted) throw new Error(FAILURE);
  }

  async initialize(): Promise<void> {
    if (this.#initialized || this.#stopped) return;
    if (this.#faulted) throw new Error(FAILURE);
    const { guildId, welcomeChannelId, spotlightChannelId, spotlightUrl } = this.#options;
    if (!welcomeChannelId && !spotlightChannelId) { this.#initialized = true; return; }
    try {
      if (!canonicalDiscordIdentifier(guildId) ||
        (welcomeChannelId !== null && !canonicalDiscordIdentifier(welcomeChannelId)) ||
        (spotlightChannelId !== null && (!canonicalDiscordIdentifier(spotlightChannelId) || !spotlightUrl))) throw new Error(FAILURE);
      if (spotlightChannelId && spotlightUrl) validateEndpoint(spotlightUrl);
      await this.#options.journal.initialize();
      if (!this.#stopped) this.#initialized = true;
    } catch { this.#fail(); }
  }

  async #deliver(key: string, channelId: string, content: string, currentMonth?: string): Promise<void> {
    const channel = await this.#options.resolveChannel(channelId);
    if (this.#stopped) return;
    if (currentMonth && currentMonth !== monthFor((this.#options.clock || Date.now)())) return;
    if (!channel || channel.id !== channelId || channel.guildId !== this.#options.guildId ||
      ![0, 5].includes(channel.type) || channel.canView !== true || channel.canSend !== true) throw new Error(FAILURE);
    await this.#options.journal.deliver(key, channelId, content, async (nonce) => {
      // Shutdown blocks new admission above; an already admitted journal task
      // must drain so a normal stop cannot strand an unsent durable intent.
      return this.#options.send(channelId, content, nonce);
    }, currentMonth ? () => currentMonth === monthFor((this.#options.clock || Date.now)()) : undefined);
  }

  welcome(member: WelcomeMember): Promise<void> { return this.#memberNotice(member, "welcome"); }

  goodbye(member: GoodbyeMember): Promise<void> { return this.#memberNotice(member, "goodbye"); }

  async #memberNotice(member: WelcomeMember | GoodbyeMember, kind: "welcome" | "goodbye"): Promise<void> {
    const channel = this.#options.welcomeChannelId;
    if (!channel || this.#stopped || member.guild.id !== this.#options.guildId || member.user.bot) return;
    try {
      this.#admitted();
      if (!canonicalDiscordIdentifier(member.guild.id) || !canonicalDiscordIdentifier(member.user.id)) throw new Error(FAILURE);
      let identity: string;
      if (kind === "welcome") {
        const joined = "joinedTimestamp" in member ? member.joinedTimestamp : null;
        const now = (this.#options.clock || Date.now)();
        if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(joined) ||
          joined === null || joined <= 0 || joined > now) throw new Error(FAILURE);
        identity = createHash("sha256").update(`${member.guild.id}:${member.user.id}:${joined}`).digest("hex");
      } else {
        if (!("eventIdentity" in member) || typeof member.eventIdentity !== "string" ||
          !/^[0-9a-f]{64}$/u.test(member.eventIdentity)) throw new Error(FAILURE);
        identity = member.eventIdentity;
      }
      const content = kind === "welcome"
        ? `<@${member.user.id}>\n\n${WELCOME_DM_MESSAGE}`
        : `<@${member.user.id}> has left Mōchirīī. Wishing you well on your next journey.`;
      await this.#deliver(`${kind}:${identity}`, channel, content);
    } catch { this.#fail(); }
  }

  checkSpotlight(): Promise<void> {
    if (!this.#options.spotlightChannelId || this.#stopped) return Promise.resolve();
    if (this.#spotlightInFlight) return this.#spotlightInFlight;
    this.#spotlightInFlight = this.#checkSpotlight().finally(() => { this.#spotlightInFlight = undefined; });
    return this.#spotlightInFlight;
  }

  async #checkSpotlight(): Promise<void> {
    try {
      this.#admitted();
      const endpoint = validateEndpoint(this.#options.spotlightUrl || "");
      const month = monthFor((this.#options.clock || Date.now)());
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(5000)]);
      const response = await (this.#options.fetch || fetch)(endpoint, {
        method: "GET", redirect: "error", cache: "no-store", signal,
        headers: { Accept: "application/json" },
      });
      if (this.#stopped) { void response.body?.cancel().catch(() => undefined); return; }
      if (month !== monthFor((this.#options.clock || Date.now)())) {
        void response.body?.cancel().catch(() => undefined); return;
      }
      if (response.status !== 200 || (response.url && response.url !== endpoint)) {
        void response.body?.cancel().catch(() => undefined); throw new Error(FAILURE);
      }
      const body = record(await readNoticeJsonResponse(response, MAX_RESPONSE_BYTES, signal));
      if (this.#stopped) return;
      if (month !== monthFor((this.#options.clock || Date.now)())) return;
      const data = record(body?.data);
      if (!body || !exactKeys(body, ["ok", "data"]) || body.ok !== true ||
        !data || !exactKeys(data, ["winnerName", "monthKey"]) || data.monthKey !== month) throw new Error(FAILURE);
      if (data.winnerName === null) return;
      const name = data.winnerName;
      if (typeof name !== "string" || !name || name.length > 120 || name !== name.trim() ||
        name.replace(/\s+/gu, " ") !== name || UNSAFE_NAME.test(name) || /[\ud800-\udfff]/u.test(name)) throw new Error(FAILURE);
      const content = `Mōchirīī Member Spotlight · ${month.slice(0, 7)}\n\n${escapeMarkdown(name)}\n\nThank you for being part of Mōchirīī.`;
      await this.#deliver(`spotlight:${month}`, this.#options.spotlightChannelId!, content, month);
    } catch {
      if (!this.#stopped) this.#fail();
    }
  }

  stop(): void { this.#stopped = true; this.#abort.abort(); }
}
