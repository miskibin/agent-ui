// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

/**
 * The pixel size of an image, read from its header bytes alone.
 *
 * A chart an agent just wrote arrives in the transcript as an `<img>` with no
 * dimensions, so the page reflows the moment it decodes — mid-stream, under
 * the user's cursor. The size is in the first few dozen bytes of every format
 * that matters here, so it can be sent as a header beside the file and the
 * component can reserve the box before a single pixel arrives.
 *
 * Pure and allocation-free beyond the view: hand it the head of the file, get
 * `{ width, height }` or null. Anything unrecognized, truncated or malformed
 * is null — a caller falls back to measuring after decode, which is exactly
 * what it does today.
 */

export type ImageDimensions = { width: number; height: number }

/**
 * How much of the file the reader needs. Everything but JPEG answers inside
 * the first 32 bytes; a JPEG's frame header can sit behind several 64 KiB
 * metadata segments (EXIF, an ICC profile, XMP), so allow a few of them.
 */
export const IMAGE_HEADER_BYTES = 256 * 1024

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const dimensions =
    readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes)
  return dimensions && dimensions.width > 0 && dimensions.height > 0
    ? dimensions
    : null
}

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** `\x89PNG` then the IHDR chunk, whose first two fields are the size. */
function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null
  }
  const data = view(bytes)
  return { width: data.getUint32(16), height: data.getUint32(20) }
}

/** `GIF8` then the logical screen descriptor, little-endian. */
function readGif(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38) {
    return null
  }
  const data = view(bytes)
  return { width: data.getUint16(6, true), height: data.getUint16(8, true) }
}

/** RIFF/WEBP, whose three sub-formats each spell the size differently. */
function readWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 16) return null
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return null
  }
  const data = view(bytes)
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  switch (chunk) {
    case "VP8 ":
      if (bytes.length < 30) return null
      // Lossy: 14-bit dimensions after the 3-byte frame tag and start code.
      return {
        width: data.getUint16(26, true) & 0x3fff,
        height: data.getUint16(28, true) & 0x3fff,
      }
    case "VP8L": {
      if (bytes.length < 25) return null
      // Lossless: width-1 in bits 0-13 and height-1 in bits 14-27 of the
      // 32 bits after the signature byte.
      const packed = data.getUint32(21, true)
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
    }
    case "VP8X":
      if (bytes.length < 30) return null
      // Extended: 24-bit canvas dimensions, each stored minus one.
      return {
        width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
        height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
      }
    default:
      return null
  }
}

/** Walk the segment chain to the start-of-frame marker that carries the size. */
function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const data = view(bytes)
  let offset = 2
  let rotated = false
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    // Padding between segments.
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // SOF0-SOF15 carry the dimensions; the Huffman, arithmetic-coding and
    // restart-interval markers share that range and do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = data.getUint16(offset + 5)
      const width = data.getUint16(offset + 7)
      return rotated ? { width: height, height: width } : { width, height }
    }
    if (marker === 0xd9 || marker === 0xda) return null
    // TEM and the restart markers stand alone, with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = data.getUint16(offset + 2)
    if (length < 2) return null
    // A viewer applies the EXIF orientation before display, so a phone photo
    // stored on its side takes the swapped box on screen.
    if (marker === 0xe1 && !rotated) {
      rotated = exifOrientationSwapsAxes(bytes, offset + 4, offset + 2 + length)
    }
    offset += 2 + length
  }
  return null
}

/** Whether EXIF orientation 5-8 (a 90° rotation) applies. `start` is the APP1 payload. */
function exifOrientationSwapsAxes(
  bytes: Uint8Array,
  start: number,
  rawEnd: number
): boolean {
  const end = Math.min(rawEnd, bytes.length)
  // "Exif\0\0", then a TIFF header: byte order, 0x2a, and the IFD0 offset.
  if (
    end - start < 14 ||
    String.fromCharCode(...bytes.subarray(start, start + 4)) !== "Exif"
  ) {
    return false
  }
  const tiff = start + 6
  const data = view(bytes)
  const littleEndian = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
  if (!littleEndian && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return false
  const ifd = tiff + data.getUint32(tiff + 4, littleEndian)
  if (ifd + 2 > end) return false
  const entries = data.getUint16(ifd, littleEndian)
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12
    if (entry + 12 > end) return false
    if (data.getUint16(entry, littleEndian) === 0x0112) {
      const orientation = data.getUint16(entry + 8, littleEndian)
      return orientation >= 5 && orientation <= 8
    }
  }
  return false
}
