export const STRICT_JSON_DEFAULT_MAX_BYTES = 64 * 1024;
export const STRICT_JSON_DEFAULT_MAX_DEPTH = 64;

const encoder = new TextEncoder();
const NUMBER_PREFIX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u;
const HEX_DIGIT = /^[0-9a-f]$/iu;

export class StrictJsonError extends SyntaxError {
  constructor(message = "JSON is invalid or contains a duplicate object key.") {
    super(message);
    this.name = "StrictJsonError";
  }
}

export type StrictJsonOptions = {
  maximumBytes?: number;
  maximumDepth?: number;
};

function checkedLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Strict JSON limits must be positive safe integers.");
  }
  return limit;
}

/**
 * Parses JSON while rejecting duplicate object keys, including escaped-key
 * aliases such as `"role"` and `"r\\u006fle"`. JSON.parse alone keeps the
 * last value and is therefore unsafe for authenticated or privileged input.
 */
export function parseJsonNoDuplicateKeys(
  value: string,
  options: StrictJsonOptions = {},
): unknown {
  const source = String(value);
  const maximumBytes = checkedLimit(
    options.maximumBytes,
    STRICT_JSON_DEFAULT_MAX_BYTES,
  );
  const maximumDepth = checkedLimit(
    options.maximumDepth,
    STRICT_JSON_DEFAULT_MAX_DEPTH,
  );
  if (encoder.encode(source).byteLength > maximumBytes) {
    throw new StrictJsonError("JSON exceeds the configured byte limit.");
  }

  let cursor = 0;

  function invalid(): never {
    throw new StrictJsonError();
  }

  function skipWhitespace(): void {
    while (
      source[cursor] === " " || source[cursor] === "\t" ||
      source[cursor] === "\r" || source[cursor] === "\n"
    ) cursor += 1;
  }

  function readString(): string {
    if (source[cursor] !== '"') invalid();
    const start = cursor;
    cursor += 1;
    for (;;) {
      if (cursor >= source.length) invalid();
      const character = source[cursor];
      if (character === '"') {
        cursor += 1;
        try {
          return JSON.parse(source.slice(start, cursor)) as string;
        } catch {
          invalid();
        }
      }
      if (character === "\\") {
        cursor += 1;
        const escape = source[cursor];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) invalid();
        if (escape === "u") {
          for (let offset = 1; offset <= 4; offset += 1) {
            if (!HEX_DIGIT.test(source[cursor + offset] || "")) invalid();
          }
          cursor += 5;
        } else {
          cursor += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) invalid();
      cursor += 1;
    }
  }

  function readLiteral(literal: string): void {
    if (source.slice(cursor, cursor + literal.length) !== literal) invalid();
    cursor += literal.length;
  }

  function readNumber(): void {
    const match = NUMBER_PREFIX.exec(source.slice(cursor));
    if (!match) invalid();
    cursor += match[0].length;
  }

  function readArray(depth: number): void {
    cursor += 1;
    skipWhitespace();
    if (source[cursor] === "]") {
      cursor += 1;
      return;
    }
    for (;;) {
      readValue(depth + 1);
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      if (source[cursor] !== ",") invalid();
      cursor += 1;
      skipWhitespace();
    }
  }

  function readObject(depth: number): void {
    cursor += 1;
    skipWhitespace();
    if (source[cursor] === "}") {
      cursor += 1;
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      const key = readString();
      if (keys.has(key)) invalid();
      keys.add(key);
      skipWhitespace();
      if (source[cursor] !== ":") invalid();
      cursor += 1;
      skipWhitespace();
      readValue(depth + 1);
      skipWhitespace();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      if (source[cursor] !== ",") invalid();
      cursor += 1;
      skipWhitespace();
    }
  }

  function readValue(depth: number): void {
    if (depth > maximumDepth) {
      throw new StrictJsonError("JSON exceeds the configured nesting limit.");
    }
    skipWhitespace();
    const character = source[cursor];
    if (character === "{") return readObject(depth);
    if (character === "[") return readArray(depth);
    if (character === '"') {
      readString();
      return;
    }
    if (character === "t") return readLiteral("true");
    if (character === "f") return readLiteral("false");
    if (character === "n") return readLiteral("null");
    readNumber();
  }

  readValue(0);
  skipWhitespace();
  if (cursor !== source.length) invalid();

  try {
    return JSON.parse(source) as unknown;
  } catch {
    invalid();
  }
}

export function parseJsonObjectNoDuplicateKeys(
  value: string,
  options: StrictJsonOptions = {},
): Record<string, unknown> {
  const parsed = parseJsonNoDuplicateKeys(value, options);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StrictJsonError("JSON must be an object.");
  }
  return parsed as Record<string, unknown>;
}
