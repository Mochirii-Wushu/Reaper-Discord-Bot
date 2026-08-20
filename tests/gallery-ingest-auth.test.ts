import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGalleryConfig } from "../src/config.js";
import {
  createDiscordGalleryIngestHeaders,
  createDiscordGalleryIngestSignature,
  DISCORD_GALLERY_INGEST_HEADERS,
  DISCORD_GALLERY_INGEST_ORIGIN,
  DISCORD_GALLERY_INGEST_PATH,
  discordGalleryIngestCanonicalMessage,
  discordGalleryIngestEndpoint,
  parseDiscordGalleryIngestHmacKeys,
  randomDiscordGalleryIngestNonce,
} from "../src/gallery-ingest-auth.js";
import { SYNTHETIC_DISCORD_IDS } from "./discord-fixtures.js";

type Fixture = {
  synthetic: boolean;
  keyId: string;
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
  canonicalMessage: string;
  signature: string;
};

const fixture = JSON.parse(readFileSync(
  resolve(import.meta.dir, "../contracts/fixtures/gallery-ingest-hmac-v1.json"),
  "utf8",
)) as Fixture;

describe("Discord Gallery ingest HMAC", () => {
  test("matches the deterministic cross-repository protocol vector", () => {
    expect(fixture.synthetic).toBe(true);
    expect(discordGalleryIngestCanonicalMessage({
      keyId: fixture.keyId,
      method: fixture.method,
      path: fixture.path,
      timestamp: fixture.timestamp,
      nonce: fixture.nonce,
      rawBody: fixture.rawBody,
    })).toBe(fixture.canonicalMessage);
    expect(createDiscordGalleryIngestSignature({
      secret: fixture.secret,
      keyId: fixture.keyId,
      timestamp: fixture.timestamp,
      nonce: fixture.nonce,
      rawBody: fixture.rawBody,
      method: fixture.method,
      path: fixture.path,
    })).toBe(fixture.signature);
  });

  test("creates exactly the four current HMAC and replay headers", () => {
    const keys = parseDiscordGalleryIngestHmacKeys(JSON.stringify({
      primary: fixture.secret,
    }));
    expect(keys).not.toBeNull();
    const headers = createDiscordGalleryIngestHeaders({
      keys: keys!,
      activeKeyId: "primary",
      rawBody: fixture.rawBody,
      nowMs: Number(fixture.timestamp) * 1000,
      nonce: fixture.nonce,
    });
    expect(Object.keys(headers)).toEqual(Object.values(DISCORD_GALLERY_INGEST_HEADERS));
    expect(headers[DISCORD_GALLERY_INGEST_HEADERS.signature]).toBe(fixture.signature);
    expect(() => createDiscordGalleryIngestHeaders({
      keys: keys!,
      activeKeyId: "primary",
      rawBody: "x".repeat(16 * 1024 + 1),
      nowMs: Number(fixture.timestamp) * 1000,
      nonce: fixture.nonce,
    })).toThrow("gallery_ingest_hmac_invalid");
  });

  test("supports bounded key rotation and rejects weak or ambiguous key sets", () => {
    const secondary = "fedcba9876543210fedcba9876543210";
    expect(parseDiscordGalleryIngestHmacKeys(JSON.stringify({
      primary: fixture.secret,
      next: secondary,
    }))).toEqual({ primary: fixture.secret, next: secondary });
    expect(parseDiscordGalleryIngestHmacKeys("{}")).toBeNull();
    expect(parseDiscordGalleryIngestHmacKeys(JSON.stringify({ primary: "short" }))).toBeNull();
    expect(parseDiscordGalleryIngestHmacKeys(JSON.stringify({
      primary: fixture.secret,
      duplicate: fixture.secret,
    }))).toBeNull();
    expect(parseDiscordGalleryIngestHmacKeys(JSON.stringify({
      a: fixture.secret,
      b: secondary,
      c: "c".repeat(32),
      d: "d".repeat(32),
    }))).toBeNull();
  });

  test("uses a 128-bit lowercase nonce and the exact HTTPS functions endpoint", () => {
    expect(randomDiscordGalleryIngestNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(discordGalleryIngestEndpoint(`${DISCORD_GALLERY_INGEST_ORIGIN}/functions/v1/`))
      .toBe(`${DISCORD_GALLERY_INGEST_ORIGIN}${DISCORD_GALLERY_INGEST_PATH}`);
    for (const invalid of [
      "https://synthetic-untrusted.invalid/functions/v1",
      `${DISCORD_GALLERY_INGEST_ORIGIN}:8443/functions/v1`,
      `http://${new URL(DISCORD_GALLERY_INGEST_ORIGIN).host}/functions/v1`,
      `https://user:pass@${new URL(DISCORD_GALLERY_INGEST_ORIGIN).host}/functions/v1`,
      `${DISCORD_GALLERY_INGEST_ORIGIN}/functions/v1?debug=1`,
      `${DISCORD_GALLERY_INGEST_ORIGIN}/functions/v1/other`,
    ]) {
      expect(() => discordGalleryIngestEndpoint(invalid)).toThrow();
    }
  });

  test("loads only a valid bounded HMAC key set and active key", () => {
    const baseEnv = {
      DISCORD_BOT_TOKEN: "synthetic-token",
      DISCORD_APPLICATION_ID: SYNTHETIC_DISCORD_IDS.otherGuild,
      DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
      DISCORD_GALLERY_CHANNEL_ID: SYNTHETIC_DISCORD_IDS.galleryChannel,
      SUPABASE_FUNCTIONS_URL: `${DISCORD_GALLERY_INGEST_ORIGIN}/functions/v1`,
      DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON: JSON.stringify({ primary: fixture.secret }),
      DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID: "primary",
    };
    const config = loadGalleryConfig(baseEnv);
    expect(config.discordGalleryIngestHmacActiveKeyId).toBe("primary");
    expect(config.discordGalleryIngestHmacKeys.primary).toBe(fixture.secret);
    expect(() => loadGalleryConfig({
      ...baseEnv,
      DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID: "retired",
    })).toThrow("Discord Gallery ingest HMAC configuration is invalid.");
    expect(() => loadGalleryConfig({
      ...baseEnv,
      SUPABASE_FUNCTIONS_URL: `http://${new URL(DISCORD_GALLERY_INGEST_ORIGIN).host}/functions/v1`,
    })).toThrow("SUPABASE_FUNCTIONS_URL must be the canonical HTTPS functions/v1 URL.");
  });
});
