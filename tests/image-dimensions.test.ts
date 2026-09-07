import assert from "node:assert/strict"
import { test } from "node:test"

import { readImageDimensions } from "@/lib/image-dimensions"

/**
 * The size a picture will take on screen, read from its header alone — what
 * `GET /api/files` sends as `X-Image-Width` / `X-Image-Height` so a component
 * can reserve the box before the bytes arrive.
 */

function png(width: number, height: number) {
  const bytes = Buffer.alloc(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write("IHDR", 12, "latin1")
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function gif(width: number, height: number) {
  const bytes = Buffer.alloc(10)
  bytes.write("GIF89a", 0, "latin1")
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

function webp(chunk: string, fill: (bytes: Buffer) => void) {
  const bytes = Buffer.alloc(32)
  bytes.write("RIFF", 0, "latin1")
  bytes.write("WEBP", 8, "latin1")
  bytes.write(chunk, 12, "latin1")
  fill(bytes)
  return bytes
}

/** `segments` are `[marker, payload]`, written with their two-byte length. */
function jpeg(segments: Array<[number, Buffer]>) {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  for (const [marker, payload] of segments) {
    const header = Buffer.alloc(4)
    header.writeUInt8(0xff, 0)
    header.writeUInt8(marker, 1)
    header.writeUInt16BE(payload.length + 2, 2)
    parts.push(header, payload)
  }
  return Buffer.concat(parts)
}

function sofPayload(width: number, height: number) {
  const payload = Buffer.alloc(15)
  payload.writeUInt8(8, 0)
  payload.writeUInt16BE(height, 1)
  payload.writeUInt16BE(width, 3)
  return payload
}

/** An APP1 payload whose IFD0 carries one orientation tag. */
function exifPayload(orientation: number) {
  const payload = Buffer.alloc(6 + 8 + 2 + 12 + 4)
  payload.write("Exif\0\0", 0, "latin1")
  const tiff = 6
  payload.write("II", tiff, "latin1")
  payload.writeUInt16LE(0x2a, tiff + 2)
  payload.writeUInt32LE(8, tiff + 4)
  payload.writeUInt16LE(1, tiff + 8)
  payload.writeUInt16LE(0x0112, tiff + 10)
  payload.writeUInt16LE(3, tiff + 12)
  payload.writeUInt32LE(1, tiff + 14)
  payload.writeUInt16LE(orientation, tiff + 18)
  return payload
}

test("PNG and GIF read straight off their headers", () => {
  assert.deepEqual(readImageDimensions(png(1531, 889)), { width: 1531, height: 889 })
  assert.deepEqual(readImageDimensions(gif(64, 48)), { width: 64, height: 48 })
})

test("all three WebP shapes", () => {
  const lossy = webp("VP8 ", (bytes) => {
    bytes.writeUInt16LE(320, 26)
    bytes.writeUInt16LE(240, 28)
  })
  assert.deepEqual(readImageDimensions(lossy), { width: 320, height: 240 })

  const lossless = webp("VP8L", (bytes) => {
    // width-1 in bits 0-13, height-1 in bits 14-27.
    bytes.writeUInt32LE((319 & 0x3fff) | ((239 & 0x3fff) << 14), 21)
  })
  assert.deepEqual(readImageDimensions(lossless), { width: 320, height: 240 })

  const extended = webp("VP8X", (bytes) => {
    bytes.writeUIntLE(1023, 24, 3)
    bytes.writeUIntLE(511, 27, 3)
  })
  assert.deepEqual(readImageDimensions(extended), { width: 1024, height: 512 })
})

test("a JPEG's frame header is found behind its metadata segments", () => {
  const bytes = jpeg([
    [0xe0, Buffer.alloc(14)],
    [0xe2, Buffer.alloc(600)],
    [0xc0, sofPayload(800, 600)],
  ])
  assert.deepEqual(readImageDimensions(bytes), { width: 800, height: 600 })
})

test("a rotated JPEG reports the box it will actually occupy", () => {
  const upright = jpeg([
    [0xe1, exifPayload(1)],
    [0xc0, sofPayload(4032, 3024)],
  ])
  assert.deepEqual(readImageDimensions(upright), { width: 4032, height: 3024 })
  const sideways = jpeg([
    [0xe1, exifPayload(6)],
    [0xc0, sofPayload(4032, 3024)],
  ])
  assert.deepEqual(readImageDimensions(sideways), { width: 3024, height: 4032 })
})

test("anything unrecognized, truncated or zero-sized is null", () => {
  assert.equal(readImageDimensions(new Uint8Array(0)), null)
  assert.equal(readImageDimensions(Buffer.from("<svg viewBox='0 0 10 10'/>")), null)
  assert.equal(readImageDimensions(png(1531, 889).subarray(0, 18)), null)
  assert.equal(readImageDimensions(png(0, 10)), null)
  // A JPEG whose frame header never arrives says nothing rather than guessing.
  assert.equal(readImageDimensions(jpeg([[0xe0, Buffer.alloc(20)]])), null)
})
