import assert from "node:assert/strict"
import { test } from "node:test"

import { estimateBase64Bytes, sniffImageMimeType } from "@/lib/attachments"

/**
 * Real signatures, base64-encoded here rather than pasted, so the fixtures are
 * the bytes a browser would actually hand over rather than a string that
 * happens to start the right way.
 */
function encode(bytes: number[], trailing = 32) {
  // Real payloads keep going past the signature, and base64 pads only at the
  // very end — a fixture that stops at the marker would test a shape no file
  // ever has.
  return Buffer.from([...bytes, ...new Array(trailing).fill(0)]).toString("base64")
}

const PNG = encode([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = encode([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const GIF87 = encode([...Buffer.from("GIF87a")])
const GIF89 = encode([...Buffer.from("GIF89a")])
const WEBP = encode([
  ...Buffer.from("RIFF"),
  0x24, 0x1a, 0x00, 0x00, // little-endian file size — the varying middle
  ...Buffer.from("WEBPVP8 "),
])

test("each image signature is read off the base64 without decoding it", () => {
  assert.equal(sniffImageMimeType(PNG), "image/png")
  assert.equal(sniffImageMimeType(JPEG), "image/jpeg")
  assert.equal(sniffImageMimeType(GIF87), "image/gif")
  assert.equal(sniffImageMimeType(GIF89), "image/gif")
  assert.equal(sniffImageMimeType(WEBP), "image/webp")
})

test("a webp is recognised whatever its size bytes are", () => {
  // Characters 8-11 of the base64 cover the size, so the "WEBP" marker has to
  // be matched where its own aligned group lands, not at a fixed offset.
  for (const size of [0, 1, 255, 0x4a3b2c]) {
    const bytes = [
      ...Buffer.from("RIFF"),
      size & 0xff,
      (size >> 8) & 0xff,
      (size >> 16) & 0xff,
      (size >> 24) & 0xff,
      ...Buffer.from("WEBPVP8L"),
    ]
    assert.equal(sniffImageMimeType(encode(bytes)), "image/webp", `size ${size}`)
  }
})

test("a RIFF that is not a webp is not called one", () => {
  const wav = encode([
    ...Buffer.from("RIFF"),
    0x24, 0x00, 0x00, 0x00,
    ...Buffer.from("WAVEfmt "),
  ])
  assert.equal(sniffImageMimeType(wav), "image/png")
})

test("anything unrecognised falls back to png rather than failing", () => {
  assert.equal(sniffImageMimeType(""), "image/png")
  assert.equal(sniffImageMimeType("bm90IGFuIGltYWdlIGF0IGFsbA=="), "image/png")
  // Leading whitespace survives some copy-paste paths and must not shift the
  // signature out from under the match.
  assert.equal(sniffImageMimeType(`\n  ${PNG}`), "image/png")
  assert.equal(sniffImageMimeType(`  ${JPEG}`), "image/jpeg")
})

test("the size estimate tracks the padding", () => {
  assert.equal(estimateBase64Bytes(Buffer.alloc(3).toString("base64")), 3)
  assert.equal(estimateBase64Bytes(Buffer.alloc(4).toString("base64")), 4)
  assert.equal(estimateBase64Bytes(Buffer.alloc(5).toString("base64")), 5)
})
