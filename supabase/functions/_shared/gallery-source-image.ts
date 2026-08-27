export const GALLERY_SOURCE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const GALLERY_SOURCE_IMAGE_MAX_EDGE = 4096;
export const GALLERY_SOURCE_IMAGE_MAX_PIXELS = 12_600_000;
// This versioned adapter intentionally preserves the predecessor validator's
// wire evidence while making Reaper's local ownership boundary explicit.
export const GALLERY_SOURCE_IMAGE_ADAPTER_CONTRACT =
  "reaper-gallery-source-image-adapter.v1" as const;
export const GALLERY_SOURCE_IMAGE_VALIDATOR_VERSION =
  "reaper-gallery-source-adapter-v1" as const;

export type GallerySourceImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type GallerySourceImageEvidence = {
  mimeType: GallerySourceImageMimeType;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  validatorVersion: typeof GALLERY_SOURCE_IMAGE_VALIDATOR_VERSION;
};

export type GallerySourceImageValidationError =
  | "source_image_bytes_invalid"
  | "source_image_bytes_too_large"
  | "source_image_type_unsupported"
  | "source_image_declared_mime_invalid"
  | "source_image_mime_mismatch"
  | "source_image_jpeg_invalid"
  | "source_image_jpeg_mode_unsupported"
  | "source_image_jpeg_precision_unsupported"
  | "source_image_jpeg_components_unsupported"
  | "source_image_png_invalid"
  | "source_image_png_mode_unsupported"
  | "source_image_png_animated"
  | "source_image_webp_invalid"
  | "source_image_webp_features_unsupported"
  | "source_image_dimensions_out_of_bounds"
  | "source_image_pixel_count_out_of_bounds";

export type GallerySourceImageValidationResult =
  | { ok: true; source: GallerySourceImageEvidence }
  | { ok: false; error: GallerySourceImageValidationError };

type DimensionParseResult =
  | { ok: true; width: number; height: number }
  | { ok: false; error: GallerySourceImageValidationError };

const PNG_SIGNATURE = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

const JPEG_SUPPORTED_SOF_MARKERS = new Set([0xc0, 0xc2]);
const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);
const WEBP_STATIC_CHUNKS = new Set(["VP8X", "ALPH", "VP8 ", "VP8L"]);
const WEBP_ALPHA_FLAG = 0x10;

function bytesEqualAt(
  bytes: Uint8Array,
  expected: Uint8Array,
  offset = 0,
): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  let value = "";
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index]);
  }
  return value;
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0, false);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0, true);
}

function detectMimeType(bytes: Uint8Array): GallerySourceImageMimeType | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (bytesEqualAt(bytes, PNG_SIGNATURE)) return "image/png";
  if (
    bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function parseJpeg(bytes: Uint8Array): DimensionParseResult {
  if (
    bytes.length < 14 || bytes[0] !== 0xff || bytes[1] !== 0xd8
  ) {
    return { ok: false, error: "source_image_jpeg_invalid" };
  }

  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  let componentIds: Set<number> | null = null;
  let scanCount = 0;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return { ok: false, error: "source_image_jpeg_invalid" };
    }

    let markerOffset = offset;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    if (markerOffset >= bytes.length) {
      return { ok: false, error: "source_image_jpeg_invalid" };
    }

    const marker = bytes[markerOffset];
    offset = markerOffset + 1;

    if (marker === 0x00 || marker === 0xd8 || marker === 0x01) {
      return { ok: false, error: "source_image_jpeg_invalid" };
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      return { ok: false, error: "source_image_jpeg_invalid" };
    }
    if (marker === 0xd9) {
      if (!dimensions || scanCount < 1 || offset !== bytes.length) {
        return { ok: false, error: "source_image_jpeg_invalid" };
      }
      return { ok: true, ...dimensions };
    }
    if (offset + 2 > bytes.length) {
      return { ok: false, error: "source_image_jpeg_invalid" };
    }

    const segmentLength = uint16be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return { ok: false, error: "source_image_jpeg_invalid" };
    }
    const dataOffset = offset + 2;
    const segmentEnd = offset + segmentLength;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (!JPEG_SUPPORTED_SOF_MARKERS.has(marker)) {
        return { ok: false, error: "source_image_jpeg_mode_unsupported" };
      }
      if (dimensions || segmentLength < 11) {
        return { ok: false, error: "source_image_jpeg_invalid" };
      }

      const precision = bytes[dataOffset];
      const height = uint16be(bytes, dataOffset + 1);
      const width = uint16be(bytes, dataOffset + 3);
      const componentCount = bytes[dataOffset + 5];

      if (precision !== 8) {
        return {
          ok: false,
          error: "source_image_jpeg_precision_unsupported",
        };
      }
      if (componentCount < 1 || componentCount > 4) {
        return {
          ok: false,
          error: "source_image_jpeg_components_unsupported",
        };
      }
      if (
        width < 1 || height < 1 ||
        segmentLength !== 8 + (3 * componentCount)
      ) {
        return { ok: false, error: "source_image_jpeg_invalid" };
      }

      const ids = new Set<number>();
      for (let index = 0; index < componentCount; index += 1) {
        const componentOffset = dataOffset + 6 + (index * 3);
        const id = bytes[componentOffset];
        const sampling = bytes[componentOffset + 1];
        const horizontalSampling = sampling >> 4;
        const verticalSampling = sampling & 0x0f;
        const quantizationTable = bytes[componentOffset + 2];
        if (
          ids.has(id) || horizontalSampling < 1 || horizontalSampling > 4 ||
          verticalSampling < 1 || verticalSampling > 4 ||
          quantizationTable > 3
        ) {
          return { ok: false, error: "source_image_jpeg_invalid" };
        }
        ids.add(id);
      }

      dimensions = { width, height };
      componentIds = ids;
    } else if (marker === 0xdc) {
      // Define-number-of-lines can replace the frame height after parsing.
      return { ok: false, error: "source_image_jpeg_mode_unsupported" };
    } else if (marker === 0xda) {
      if (!dimensions || !componentIds || segmentLength < 8) {
        return { ok: false, error: "source_image_jpeg_invalid" };
      }

      const scanComponents = bytes[dataOffset];
      if (
        scanComponents < 1 || scanComponents > componentIds.size ||
        segmentLength !== 6 + (2 * scanComponents)
      ) {
        return { ok: false, error: "source_image_jpeg_invalid" };
      }

      const scanIds = new Set<number>();
      for (let index = 0; index < scanComponents; index += 1) {
        const selectorOffset = dataOffset + 1 + (index * 2);
        const id = bytes[selectorOffset];
        const tableSelectors = bytes[selectorOffset + 1];
        if (
          !componentIds.has(id) || scanIds.has(id) ||
          (tableSelectors >> 4) > 3 || (tableSelectors & 0x0f) > 3
        ) {
          return { ok: false, error: "source_image_jpeg_invalid" };
        }
        scanIds.add(id);
      }

      const spectralOffset = dataOffset + 1 + (scanComponents * 2);
      const spectralStart = bytes[spectralOffset];
      const spectralEnd = bytes[spectralOffset + 1];
      const approximation = bytes[spectralOffset + 2];
      if (
        spectralStart > 63 || spectralEnd > 63 ||
        spectralStart > spectralEnd || (approximation >> 4) > 13 ||
        (approximation & 0x0f) > 13
      ) {
        return { ok: false, error: "source_image_jpeg_invalid" };
      }

      scanCount += 1;
      offset = segmentEnd;
      let foundMarker = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }

        let codeOffset = offset + 1;
        while (codeOffset < bytes.length && bytes[codeOffset] === 0xff) {
          codeOffset += 1;
        }
        if (codeOffset >= bytes.length) break;

        const scanMarker = bytes[codeOffset];
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          offset = codeOffset + 1;
          continue;
        }

        foundMarker = true;
        break;
      }
      if (!foundMarker) {
        return { ok: false, error: "source_image_jpeg_invalid" };
      }
      continue;
    }

    offset = segmentEnd;
  }

  return { ok: false, error: "source_image_jpeg_invalid" };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isPngChunkName(bytes: Uint8Array, offset: number): boolean {
  for (let index = offset; index < offset + 4; index += 1) {
    const byte = bytes[index];
    if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) {
      return false;
    }
  }
  return true;
}

function parsePng(bytes: Uint8Array): DimensionParseResult {
  if (bytes.length < 45 || !bytesEqualAt(bytes, PNG_SIGNATURE)) {
    return { ok: false, error: "source_image_png_invalid" };
  }

  let offset = PNG_SIGNATURE.length;
  let dimensions: { width: number; height: number } | null = null;
  let colorType: number | null = null;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let totalImageDataBytes = 0;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      return { ok: false, error: "source_image_png_invalid" };
    }

    const dataLength = uint32be(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + dataLength;
    const chunkEnd = dataEnd + 4;
    if (
      !isPngChunkName(bytes, typeOffset) || dataEnd < dataOffset ||
      chunkEnd > bytes.length || (bytes[typeOffset + 2] & 0x20) !== 0
    ) {
      return { ok: false, error: "source_image_png_invalid" };
    }

    const chunkType = ascii(bytes, typeOffset, 4);
    const expectedCrc = uint32be(bytes, dataEnd);
    if (crc32(bytes, typeOffset, dataEnd) !== expectedCrc) {
      return { ok: false, error: "source_image_png_invalid" };
    }

    if (chunkType === "IHDR") {
      if (offset !== PNG_SIGNATURE.length || dimensions || dataLength !== 13) {
        return { ok: false, error: "source_image_png_invalid" };
      }

      const width = uint32be(bytes, dataOffset);
      const height = uint32be(bytes, dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8];
      colorType = bytes[dataOffset + 9];
      const compression = bytes[dataOffset + 10];
      const filter = bytes[dataOffset + 11];
      const interlace = bytes[dataOffset + 12];

      if (
        bitDepth !== 8 || ![0, 2, 3, 4, 6].includes(colorType) ||
        compression !== 0 || filter !== 0 || interlace > 1
      ) {
        return { ok: false, error: "source_image_png_mode_unsupported" };
      }
      if (width < 1 || height < 1) {
        return { ok: false, error: "source_image_png_invalid" };
      }
      dimensions = { width, height };
    } else {
      if (!dimensions) {
        return { ok: false, error: "source_image_png_invalid" };
      }
      if (
        chunkType === "acTL" || chunkType === "fcTL" || chunkType === "fdAT"
      ) {
        return { ok: false, error: "source_image_png_animated" };
      }
      if (chunkType === "PLTE") {
        if (
          sawPalette || sawImageData || dataLength < 3 || dataLength > 768 ||
          dataLength % 3 !== 0 || colorType === 0 || colorType === 4
        ) {
          return { ok: false, error: "source_image_png_invalid" };
        }
        sawPalette = true;
      } else if (chunkType === "IDAT") {
        if (imageDataEnded || dataLength === 0) {
          return { ok: false, error: "source_image_png_invalid" };
        }
        sawImageData = true;
        totalImageDataBytes += dataLength;
      } else if (chunkType === "IEND") {
        if (
          dataLength !== 0 || !sawImageData || totalImageDataBytes < 1 ||
          (colorType === 3 && !sawPalette) || chunkEnd !== bytes.length
        ) {
          return { ok: false, error: "source_image_png_invalid" };
        }
        return { ok: true, ...dimensions };
      } else {
        if (sawImageData) imageDataEnded = true;
        // A capital first letter denotes a critical chunk. Unknown critical
        // chunks require decoder behavior this boundary does not implement.
        if ((bytes[typeOffset] & 0x20) === 0) {
          return { ok: false, error: "source_image_png_mode_unsupported" };
        }
      }
    }

    offset = chunkEnd;
  }

  return { ok: false, error: "source_image_png_invalid" };
}

function parseWebp(bytes: Uint8Array): DimensionParseResult {
  if (
    bytes.length < 26 || ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" || uint32le(bytes, 4) + 8 !== bytes.length
  ) {
    return { ok: false, error: "source_image_webp_invalid" };
  }

  let offset = 12;
  let chunkIndex = 0;
  let canvasDimensions: { width: number; height: number } | null = null;
  let imageDimensions: { width: number; height: number } | null = null;
  let vp8xFlags: number | null = null;
  let alphaChunkPresent = false;
  let losslessAlpha = false;
  let imageChunk: "VP8 " | "VP8L" | null = null;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return { ok: false, error: "source_image_webp_invalid" };
    }

    const chunkType = ascii(bytes, offset, 4);
    const chunkSize = uint32le(bytes, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    const paddedEnd = dataEnd + (chunkSize % 2);
    if (
      !WEBP_STATIC_CHUNKS.has(chunkType) || dataEnd < dataOffset ||
      paddedEnd > bytes.length
    ) {
      return {
        ok: false,
        error: !WEBP_STATIC_CHUNKS.has(chunkType)
          ? "source_image_webp_features_unsupported"
          : "source_image_webp_invalid",
      };
    }
    if (imageDimensions) {
      return { ok: false, error: "source_image_webp_invalid" };
    }
    if (paddedEnd > dataEnd && bytes[dataEnd] !== 0) {
      return { ok: false, error: "source_image_webp_invalid" };
    }

    if (chunkType === "VP8X") {
      if (
        chunkIndex !== 0 || canvasDimensions || chunkSize !== 10 ||
        (bytes[dataOffset] & ~WEBP_ALPHA_FLAG) !== 0 ||
        bytes[dataOffset + 1] !== 0 || bytes[dataOffset + 2] !== 0 ||
        bytes[dataOffset + 3] !== 0
      ) {
        return {
          ok: false,
          error: (bytes[dataOffset] & ~WEBP_ALPHA_FLAG) !== 0
            ? "source_image_webp_features_unsupported"
            : "source_image_webp_invalid",
        };
      }
      vp8xFlags = bytes[dataOffset];
      canvasDimensions = {
        width: uint24le(bytes, dataOffset + 4) + 1,
        height: uint24le(bytes, dataOffset + 7) + 1,
      };
    } else if (chunkType === "ALPH") {
      const header = bytes[dataOffset];
      if (
        !canvasDimensions || alphaChunkPresent || chunkSize < 2 ||
        vp8xFlags === null || (vp8xFlags & WEBP_ALPHA_FLAG) === 0 ||
        (header & 0xc3) !== 0 || ((header >> 4) & 0x03) > 1
      ) {
        return { ok: false, error: "source_image_webp_invalid" };
      }
      alphaChunkPresent = true;
    } else if (chunkType === "VP8L") {
      if (
        alphaChunkPresent || chunkSize < 5 || bytes[dataOffset] !== 0x2f ||
        (bytes[dataOffset + 4] >> 5) !== 0 ||
        (!canvasDimensions && chunkIndex !== 0)
      ) {
        return { ok: false, error: "source_image_webp_invalid" };
      }
      imageChunk = chunkType;
      losslessAlpha = (bytes[dataOffset + 4] & 0x10) !== 0;
      imageDimensions = {
        width: 1 + bytes[dataOffset + 1] +
          ((bytes[dataOffset + 2] & 0x3f) << 8),
        height: 1 + (bytes[dataOffset + 2] >> 6) +
          (bytes[dataOffset + 3] << 2) +
          ((bytes[dataOffset + 4] & 0x0f) << 10),
      };
    } else if (chunkType === "VP8 ") {
      if (
        chunkSize < 10 || (!canvasDimensions && chunkIndex !== 0) ||
        (bytes[dataOffset] & 0x01) !== 0 ||
        ((bytes[dataOffset] >> 1) & 0x07) > 3 ||
        bytes[dataOffset + 3] !== 0x9d || bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      ) {
        return { ok: false, error: "source_image_webp_invalid" };
      }
      const firstPartitionSize = (bytes[dataOffset] |
        (bytes[dataOffset + 1] << 8) |
        (bytes[dataOffset + 2] << 16)) >>> 5;
      if (firstPartitionSize > chunkSize - 3) {
        return { ok: false, error: "source_image_webp_invalid" };
      }
      imageChunk = chunkType;
      imageDimensions = {
        width: uint16le(bytes, dataOffset + 6) & 0x3fff,
        height: uint16le(bytes, dataOffset + 8) & 0x3fff,
      };
    }

    chunkIndex += 1;
    offset = paddedEnd;
  }

  if (offset !== bytes.length || !imageDimensions || !imageChunk) {
    return { ok: false, error: "source_image_webp_invalid" };
  }
  if (
    vp8xFlags !== null && imageChunk === "VP8 " &&
    ((vp8xFlags & WEBP_ALPHA_FLAG) !== 0) !== alphaChunkPresent
  ) {
    return { ok: false, error: "source_image_webp_invalid" };
  }
  if (
    vp8xFlags !== null && imageChunk === "VP8L" &&
    ((vp8xFlags & WEBP_ALPHA_FLAG) !== 0) !== losslessAlpha
  ) {
    return { ok: false, error: "source_image_webp_invalid" };
  }
  if (
    canvasDimensions &&
    (canvasDimensions.width !== imageDimensions.width ||
      canvasDimensions.height !== imageDimensions.height)
  ) {
    return { ok: false, error: "source_image_webp_invalid" };
  }

  return { ok: true, ...(canvasDimensions ?? imageDimensions) };
}

function parseDimensions(
  bytes: Uint8Array,
  mimeType: GallerySourceImageMimeType,
): DimensionParseResult {
  if (mimeType === "image/jpeg") return parseJpeg(bytes);
  if (mimeType === "image/png") return parsePng(bytes);
  return parseWebp(bytes);
}

function normalizedDeclaredMimeType(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return String(value).trim().toLowerCase();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into an ArrayBuffer-backed view so the Web Crypto BufferSource
  // contract cannot receive a SharedArrayBuffer-backed caller view.
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function validateGallerySourceBytes(
  bytes: Uint8Array,
  expectedMime?: string | null,
): Promise<GallerySourceImageValidationResult> {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) {
    return { ok: false, error: "source_image_bytes_invalid" };
  }
  if (bytes.length > GALLERY_SOURCE_IMAGE_MAX_BYTES) {
    return { ok: false, error: "source_image_bytes_too_large" };
  }

  const mimeType = detectMimeType(bytes);
  if (!mimeType) {
    return { ok: false, error: "source_image_type_unsupported" };
  }

  const declared = normalizedDeclaredMimeType(expectedMime);
  if (
    declared !== null &&
    !["image/jpeg", "image/png", "image/webp"].includes(declared)
  ) {
    return { ok: false, error: "source_image_declared_mime_invalid" };
  }
  if (declared !== null && declared !== mimeType) {
    return { ok: false, error: "source_image_mime_mismatch" };
  }

  const dimensions = parseDimensions(bytes, mimeType);
  if (!dimensions.ok) return dimensions;
  if (
    dimensions.width > GALLERY_SOURCE_IMAGE_MAX_EDGE ||
    dimensions.height > GALLERY_SOURCE_IMAGE_MAX_EDGE
  ) {
    return { ok: false, error: "source_image_dimensions_out_of_bounds" };
  }
  if (dimensions.width * dimensions.height > GALLERY_SOURCE_IMAGE_MAX_PIXELS) {
    return { ok: false, error: "source_image_pixel_count_out_of_bounds" };
  }

  return {
    ok: true,
    source: {
      mimeType,
      width: dimensions.width,
      height: dimensions.height,
      sizeBytes: bytes.length,
      sha256: await sha256Hex(bytes),
      validatorVersion: GALLERY_SOURCE_IMAGE_VALIDATOR_VERSION,
    },
  };
}
