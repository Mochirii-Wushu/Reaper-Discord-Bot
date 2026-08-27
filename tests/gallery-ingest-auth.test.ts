import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, loadGalleryConfig } from "../src/config.js";
import {
  canonicalDiscordGalleryRequiredRoleIds,
  canonicalDiscordIdentifier,
  createDiscordGalleryAuthorizationContext,
  createDiscordGalleryIngestHeaders,
  createDiscordGalleryIngestSignature,
  DISCORD_GALLERY_INGEST_HEADERS,
  DISCORD_GALLERY_INGEST_PATH,
  discordGalleryIngestCanonicalMessage,
  discordGalleryIngestEndpoint,
  parseDiscordGalleryAttachmentOrigins,
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
    expect(fixture.method).toBe("POST");
    expect(fixture.path).toBe(DISCORD_GALLERY_INGEST_PATH);
    expect(discordGalleryIngestCanonicalMessage({
      keyId: fixture.keyId,
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
    }))?.primary).toBe(fixture.secret);
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
    expect(parseDiscordGalleryIngestHmacKeys(
      `{"primary":"${fixture.secret}","prim\\u0061ry":"${secondary}"}`,
    )).toBeNull();
  });

  test("uses a 128-bit lowercase nonce and a validated runtime HTTPS endpoint", () => {
    const origin = "https://functions.synthetic.test";
    expect(randomDiscordGalleryIngestNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(discordGalleryIngestEndpoint(`${origin}/functions/v1/`))
      .toBe(`${origin}${DISCORD_GALLERY_INGEST_PATH}`);
    for (const invalid of [
      `${origin}:8443/functions/v1`,
      "http://functions.synthetic.test/functions/v1",
      "https://user:pass@functions.synthetic.test/functions/v1",
      `${origin}/functions/v1?debug=1`,
      `${origin}/functions/v1#fragment`,
      `${origin}/functions/v1/other`,
      ` ${origin}/functions/v1`,
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
      DISCORD_GALLERY_ATTACHMENT_ORIGINS: "https://cdn.discordapp.com",
      DISCORD_REQUIRED_ROLE_IDS:
        `${SYNTHETIC_DISCORD_IDS.roleOne},${SYNTHETIC_DISCORD_IDS.roleTwo}`,
      REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED: "true",
      SUPABASE_FUNCTIONS_URL: "https://functions.synthetic.test/functions/v1",
      DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON: JSON.stringify({ primary: fixture.secret }),
      DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID: "primary",
    };
    const config = loadGalleryConfig(baseEnv);
    expect(config.discordGalleryIngestHmacActiveKeyId).toBe("primary");
    expect(config.discordGalleryIngestHmacKeys.primary).toBe(fixture.secret);
    expect(config.galleryGatewayRollbackEnabled).toBe(true);
    expect(config.discordGalleryRequiredRoleIds).toEqual([
      SYNTHETIC_DISCORD_IDS.roleOne,
      SYNTHETIC_DISCORD_IDS.roleTwo,
    ]);
    expect(() => loadGalleryConfig({
      ...baseEnv,
      REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED: "false",
    })).toThrow("Reaper Gallery Gateway rollback is disabled.");
    expect(() => loadGalleryConfig({
      ...baseEnv,
      DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID: "retired",
    })).toThrow("Discord Gallery ingest HMAC configuration is invalid.");
    expect(() => loadGalleryConfig({
      ...baseEnv,
      SUPABASE_FUNCTIONS_URL: "http://functions.synthetic.test/functions/v1",
    })).toThrow("SUPABASE_FUNCTIONS_URL is invalid.");
  });

  test("derives the exact authorization context and rejects noncanonical inputs", () => {
    const context = createDiscordGalleryAuthorizationContext({
      guildId: SYNTHETIC_DISCORD_IDS.guild,
      galleryChannelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
      requiredRoleIds: [SYNTHETIC_DISCORD_IDS.roleTwo, SYNTHETIC_DISCORD_IDS.roleOne],
    });
    expect(context?.authorizationContextVersion).toBe(
      "discord-gallery-authorization-context.v1",
    );
    expect(context?.authorizationContextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(context).toEqual(createDiscordGalleryAuthorizationContext({
      guildId: SYNTHETIC_DISCORD_IDS.guild,
      galleryChannelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
      requiredRoleIds: [SYNTHETIC_DISCORD_IDS.roleOne, SYNTHETIC_DISCORD_IDS.roleTwo],
    }));
    for (const invalid of [
      `0${SYNTHETIC_DISCORD_IDS.guild}`,
      "1844674407" + "3709551616",
      ` ${SYNTHETIC_DISCORD_IDS.guild}`,
      `+${SYNTHETIC_DISCORD_IDS.guild}`,
    ]) expect(canonicalDiscordIdentifier(invalid)).toBeNull();
    expect(canonicalDiscordGalleryRequiredRoleIds(
      `${SYNTHETIC_DISCORD_IDS.roleOne},${SYNTHETIC_DISCORD_IDS.roleOne}`,
    )).toBeNull();
    expect(canonicalDiscordGalleryRequiredRoleIds(
      `${SYNTHETIC_DISCORD_IDS.roleOne}, ${SYNTHETIC_DISCORD_IDS.roleTwo}`,
    )).toBeNull();
  });

  test("parses bounded exact attachment origins and a literal rollback gate", () => {
    expect(parseDiscordGalleryAttachmentOrigins(
      "https://cdn.discordapp.com,https://media.discordapp.net",
    )).toEqual([
      "https://cdn.discordapp.com",
      "https://media.discordapp.net",
    ]);
    for (const invalid of [
      "http://cdn.discordapp.com",
      "https://user:pass@cdn.discordapp.com",
      "https://cdn.discordapp.com/path",
      "https://cdn.discordapp.com:8443",
      "https://cdn.discordapp.com,https://cdn.discordapp.com",
      "https://outside.synthetic.test",
      " https://cdn.discordapp.com",
    ]) expect(parseDiscordGalleryAttachmentOrigins(invalid)).toBeNull();

    const base = {
      DISCORD_BOT_TOKEN: "synthetic-token",
      DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
    };
    expect(loadConfig(base).galleryGatewayRollbackEnabled).toBe(false);
    expect(loadConfig({
      ...base,
      REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED: "true",
    }).galleryGatewayRollbackEnabled).toBe(true);
    for (const invalid of ["TRUE", "1", " true", "false "]) {
      expect(() => loadConfig({
        ...base,
        REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED: invalid,
      })).toThrow("must be exactly true or false");
    }
  });
});
