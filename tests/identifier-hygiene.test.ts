import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SYNTHETIC_DISCORD_SNOWFLAKES } from "./discord-fixtures.js";

const repositoryRoot = resolve(import.meta.dir, "..");
const submitSource = readFileSync(join(repositoryRoot, "src", "submit.ts"), "utf8");
const rootTextFiles = [
  ".dockerignore",
  ".env.example",
  "AGENTS.md",
  "Dockerfile",
  "package.json",
  "README.md",
  "tsconfig.build.json",
  "tsconfig.json",
];
const scannedDirectories = [".github", "src", "tests"];
const scannedExtensions = new Set([".json", ".md", ".ts", ".yaml", ".yml"]);
const discordSnowflakePattern = /(?<!\d)\d{17,20}(?!\d)/g;

function trackedTextFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return trackedTextFiles(path);
    }

    const extension = path.slice(path.lastIndexOf("."));
    return scannedExtensions.has(extension) ? [path] : [];
  });
}

describe("tracked Discord identifier hygiene", () => {
  test("keeps production snowflakes out of samples, documentation, and tests", () => {
    const files = [
      ...rootTextFiles.map((file) => join(repositoryRoot, file)),
      ...scannedDirectories.flatMap((directory) => trackedTextFiles(join(repositoryRoot, directory))),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const matches = readFileSync(file, "utf8").match(discordSnowflakePattern) || [];
      if (matches.some((snowflake) => !SYNTHETIC_DISCORD_SNOWFLAKES.has(snowflake))) {
        violations.push(relative(repositoryRoot, file));
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("member-facing brand hygiene", () => {
  test("uses the Mōchirīī gallery name in fallback replies", () => {
    expect(submitSource).toContain(
      'const message = "Mōchirīī gallery submissions are temporarily unavailable.";',
    );
    expect(submitSource).not.toContain("on this Reaper runtime");
  });
});
