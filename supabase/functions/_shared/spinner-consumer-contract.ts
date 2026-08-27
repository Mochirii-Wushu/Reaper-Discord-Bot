export const SPINNER_MAX_PARTICIPANTS = 100;
export const SPINNER_MAX_NAME_GRAPHEMES = 40;
export const SPINNER_DISCORD_CHANNEL_KEY = "raffle_spins";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BIDI_CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069]/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export type ParticipantV1 = {
  version: 1;
  id: string;
  displayName: string;
};

export type RosterStateV1 = {
  version: 1;
  participants: ParticipantV1[];
};

export type DrawReceiptV1 = {
  version: 1;
  drawMode: "official" | "test";
  drawId: string;
  timestampIso: string;
  singaporeTime: string;
  appVersion: string;
  algorithmVersion: string;
  rosterSnapshot: RosterStateV1;
  rosterHashSha256: string;
  rejectionLimit: number;
  sampledWords: number[];
  acceptedWord: number;
  selectedIndex: number;
  winner: ParticipantV1;
};

function graphemes(value: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (typeof Segmenter === "function") {
    return Array.from(
      new Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      (part) => part.segment,
    );
  }
  return Array.from(value);
}

function normalizeDisplayName(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function normalizedNameKey(value: string): string {
  return normalizeDisplayName(value)
    .toLocaleUpperCase("und")
    .toLocaleLowerCase("und")
    .normalize("NFKC");
}

function normalizeParticipant(candidate: unknown): ParticipantV1 {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("The live roster contains an invalid participant.");
  }
  const record = candidate as Record<string, unknown>;
  const id = String(record.id || "").trim();
  const displayName = normalizeDisplayName(record.displayName);
  if (
    record.version !== 1 || !UUID_PATTERN.test(id) || !displayName ||
    graphemes(displayName).length > SPINNER_MAX_NAME_GRAPHEMES ||
    Array.from(displayName).length > SPINNER_MAX_NAME_GRAPHEMES ||
    CONTROL_PATTERN.test(displayName) || BIDI_CONTROL_PATTERN.test(displayName)
  ) {
    throw new TypeError("The live roster contains an invalid participant.");
  }
  return { version: 1, id, displayName };
}

export function normalizeParticipants(value: unknown): ParticipantV1[] {
  if (!Array.isArray(value) || value.length > SPINNER_MAX_PARTICIPANTS) {
    throw new RangeError(
      `A live roster supports 0–${SPINNER_MAX_PARTICIPANTS} participants.`,
    );
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  return value.map((candidate) => {
    const participant = normalizeParticipant(candidate);
    const nameKey = normalizedNameKey(participant.displayName);
    if (ids.has(participant.id) || names.has(nameKey)) {
      throw new TypeError("Participant IDs and names must be unique.");
    }
    ids.add(participant.id);
    names.add(nameKey);
    return participant;
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") {
    throw new Error("Secure hashing is unavailable.");
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToHex(new Uint8Array(digest));
}
