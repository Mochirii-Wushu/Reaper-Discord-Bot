import {
  type DrawReceiptV1,
  normalizeParticipants,
  type ParticipantV1,
  sha256Hex,
} from "./spinner-consumer-contract.ts";
import { parseJsonObjectNoDuplicateKeys } from "./strict-json.ts";

export const SPINNER_ANIMATION_MANIFEST_VERSION = 1;
export const SPINNER_MEDIA_STYLE_VERSION = "mochirii-raffle-film-v1";
export const SPINNER_MEDIA_WIDTH = 1_280;
export const SPINNER_MEDIA_HEIGHT = 720;
export const SPINNER_MEDIA_DURATION_MS = 10_600;
export const SPINNER_MEDIA_FALLBACK_DELAY_MS = 60_000;
export const SPINNER_MEDIA_CAPABILITY_LEASE_MS = 20 * 60_000;
export const SPINNER_MEDIA_MAX_MP4_BYTES = 4_250_000;
export const SPINNER_MEDIA_MAX_PNG_BYTES = 3 * 1_000_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type AnimationManifestParticipantV1 =
  & Pick<
    ParticipantV1,
    "version"
  >
  & { number: number; label: string };

export type AnimationManifestWinnerV1 =
  & Pick<
    ParticipantV1,
    "version" | "displayName"
  >
  & { number: number };

export type AnimationManifestV1 = {
  version: 1;
  styleVersion: typeof SPINNER_MEDIA_STYLE_VERSION;
  width: typeof SPINNER_MEDIA_WIDTH;
  height: typeof SPINNER_MEDIA_HEIGHT;
  durationMs: typeof SPINNER_MEDIA_DURATION_MS;
  drawId: string;
  startAt: string;
  revealAt: string;
  startRotation: number;
  finalRotation: number;
  rosterHashSha256: string;
  participants: AnimationManifestParticipantV1[];
  selectedIndex: number;
  winner: AnimationManifestWinnerV1;
  visualSeedSha256: string;
};

export type SpinnerMediaType = "image/png" | "video/mp4";

export type SpinnerMediaTokenPayloadV1 = {
  version: 1;
  jobId: string;
  manifestHashSha256: string;
  expiresAt: number;
};

export type SpinnerMediaValidation =
  | { ok: true; mediaType: SpinnerMediaType; extension: "png" | "mp4" }
  | { ok: false; reason: "invalid_type" | "too_large" | "invalid_signature" };

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function splitSpinnerGraphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      (part) => part.segment,
    );
  }
  return Array.from(value);
}

export function wheelSegmentLabel(
  displayName: string,
  participantCount: number,
  index: number,
): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= participantCount) {
    throw new RangeError("The wheel label position is invalid.");
  }
  const limit = participantCount > 72
    ? 7
    : participantCount > 40
    ? 10
    : participantCount > 20
    ? 14
    : 19;
  const graphemes = splitSpinnerGraphemes(displayName);
  const name = graphemes.length > limit
    ? `${graphemes.slice(0, Math.max(1, limit - 1)).join("")}…`
    : displayName;
  return `${index + 1}. ${name}`;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(
    /=+$/gu,
    "",
  );
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    );
    return Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    mismatch |= (left[index] || 0) ^ (right[index] || 0);
  }
  return mismatch === 0;
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}

export async function buildAnimationManifest(
  receipt: DrawReceiptV1,
  plan: {
    startAt: string;
    revealAt: string;
    startRotation: number;
    finalRotation: number;
  },
): Promise<AnimationManifestV1> {
  const participants = normalizeParticipants(
    receipt.rosterSnapshot.participants,
  )
    .map((participant, index) => ({
      version: 1 as const,
      number: index + 1,
      label: wheelSegmentLabel(
        participant.displayName,
        receipt.rosterSnapshot.participants.length,
        index,
      ),
    }));
  if (!participants[receipt.selectedIndex]) {
    throw new TypeError("The animation winner is outside the roster.");
  }
  const visualSeedSha256 = await sha256Hex(
    `mochirii-spinner-visual-v1\0${receipt.drawId}\0${receipt.rosterHashSha256}`,
  );
  return {
    version: SPINNER_ANIMATION_MANIFEST_VERSION,
    styleVersion: SPINNER_MEDIA_STYLE_VERSION,
    width: SPINNER_MEDIA_WIDTH,
    height: SPINNER_MEDIA_HEIGHT,
    durationMs: SPINNER_MEDIA_DURATION_MS,
    drawId: receipt.drawId,
    startAt: plan.startAt,
    revealAt: plan.revealAt,
    startRotation: plan.startRotation,
    finalRotation: plan.finalRotation,
    rosterHashSha256: receipt.rosterHashSha256,
    participants,
    selectedIndex: receipt.selectedIndex,
    winner: {
      version: 1,
      number: receipt.selectedIndex + 1,
      displayName: receipt.winner.displayName,
    },
    visualSeedSha256,
  };
}

export function parseAnimationManifest(
  value: unknown,
): AnimationManifestV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== SPINNER_ANIMATION_MANIFEST_VERSION ||
    row.styleVersion !== SPINNER_MEDIA_STYLE_VERSION ||
    row.width !== SPINNER_MEDIA_WIDTH || row.height !== SPINNER_MEDIA_HEIGHT ||
    row.durationMs !== SPINNER_MEDIA_DURATION_MS ||
    typeof row.drawId !== "string" || !UUID_PATTERN.test(row.drawId) ||
    !validIso(row.startAt) || !validIso(row.revealAt) ||
    Date.parse(row.revealAt) <= Date.parse(row.startAt) ||
    !SHA256_PATTERN.test(String(row.rosterHashSha256 || "")) ||
    !SHA256_PATTERN.test(String(row.visualSeedSha256 || "")) ||
    !Array.isArray(row.participants) || row.participants.length < 2 ||
    row.participants.length > 100
  ) return null;

  const startRotation = finiteNumber(row.startRotation);
  const finalRotation = finiteNumber(row.finalRotation);
  const selectedIndex = Number(row.selectedIndex);
  if (
    startRotation === null || finalRotation === null ||
    !Number.isSafeInteger(selectedIndex) || selectedIndex < 0 ||
    selectedIndex >= row.participants.length
  ) return null;

  const participants: AnimationManifestParticipantV1[] = [];
  for (let index = 0; index < row.participants.length; index += 1) {
    const entry = row.participants[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const participant = entry as Record<string, unknown>;
    const label = typeof participant.label === "string"
      ? participant.label
      : "";
    if (
      participant.version !== 1 || participant.number !== index + 1 ||
      !label.startsWith(`${index + 1}. `) ||
      splitSpinnerGraphemes(label).length > 24
    ) return null;
    participants.push({ version: 1, number: index + 1, label });
  }
  const winner = row.winner as Record<string, unknown> | null;
  if (
    !winner || winner.version !== 1 || winner.number !== selectedIndex + 1 ||
    typeof winner.displayName !== "string" ||
    splitSpinnerGraphemes(winner.displayName).length < 1 ||
    splitSpinnerGraphemes(winner.displayName).length > 40
  ) return null;

  return {
    version: 1,
    styleVersion: SPINNER_MEDIA_STYLE_VERSION,
    width: SPINNER_MEDIA_WIDTH,
    height: SPINNER_MEDIA_HEIGHT,
    durationMs: SPINNER_MEDIA_DURATION_MS,
    drawId: row.drawId,
    startAt: row.startAt,
    revealAt: row.revealAt,
    startRotation,
    finalRotation,
    rosterHashSha256: String(row.rosterHashSha256),
    participants,
    selectedIndex,
    winner: {
      version: 1,
      number: selectedIndex + 1,
      displayName: winner.displayName,
    },
    visualSeedSha256: String(row.visualSeedSha256),
  };
}

export async function animationManifestHash(
  manifest: AnimationManifestV1,
): Promise<string> {
  return sha256Hex(JSON.stringify(manifest));
}

export async function createSpinnerMediaToken(
  payload: SpinnerMediaTokenPayloadV1,
  secret: string,
): Promise<string> {
  if (
    !secret || !UUID_PATTERN.test(payload.jobId) ||
    !SHA256_PATTERN.test(payload.manifestHashSha256) ||
    !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= 0
  ) throw new TypeError("The media capability is invalid.");
  const encoded = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = bytesToBase64Url(
    await hmacSha256(secret, `sm1.${encoded}`),
  );
  return `sm1.${encoded}.${signature}`;
}

export async function verifySpinnerMediaToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<SpinnerMediaTokenPayloadV1 | null> {
  if (!secret || token.length > 1_024) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "sm1") return null;
  const payloadBytes = base64UrlToBytes(parts[1]);
  const signatureBytes = base64UrlToBytes(parts[2]);
  if (!payloadBytes || !signatureBytes) return null;
  const expected = await hmacSha256(secret, `sm1.${parts[1]}`);
  if (!constantTimeBytesEqual(signatureBytes, expected)) return null;
  try {
    const value = parseJsonObjectNoDuplicateKeys(
      new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
      { maximumBytes: 1_024, maximumDepth: 4 },
    );
    const payload: SpinnerMediaTokenPayloadV1 = {
      version: 1,
      jobId: String(value.jobId || ""),
      manifestHashSha256: String(value.manifestHashSha256 || ""),
      expiresAt: Number(value.expiresAt),
    };
    if (
      value.version !== 1 || !UUID_PATTERN.test(payload.jobId) ||
      !SHA256_PATTERN.test(payload.manifestHashSha256) ||
      !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= nowMs
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function spinnerMediaTokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}

export function validateSpinnerMedia(
  mediaType: string,
  bytes: Uint8Array,
): SpinnerMediaValidation {
  if (mediaType === "image/png") {
    if (bytes.byteLength > SPINNER_MEDIA_MAX_PNG_BYTES) {
      return { ok: false, reason: "too_large" };
    }
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      bytes.length < signature.length ||
      signature.some((byte, index) => bytes[index] !== byte)
    ) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: true, mediaType, extension: "png" };
  }
  if (mediaType === "video/mp4") {
    if (bytes.byteLength > SPINNER_MEDIA_MAX_MP4_BYTES) {
      return { ok: false, reason: "too_large" };
    }
    if (
      bytes.length < 12 || bytes[4] !== 0x66 || bytes[5] !== 0x74 ||
      bytes[6] !== 0x79 || bytes[7] !== 0x70
    ) return { ok: false, reason: "invalid_signature" };
    return { ok: true, mediaType, extension: "mp4" };
  }
  return { ok: false, reason: "invalid_type" };
}

export function spinnerMediaFilename(
  drawId: string,
  extension: "png" | "mp4",
): string {
  if (!UUID_PATTERN.test(drawId)) {
    throw new TypeError("The media draw ID is invalid.");
  }
  return `mochirii-raffle-${drawId}.${extension}`;
}
