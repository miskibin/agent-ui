import test from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_IMAGE_MIME, sniffImageMimeType } from "@/lib/attachments"

/** The magic bytes of each format, plus enough filler to be a real prefix. */
const base64Of = (bytes: number[]) =>
  Buffer.from([...bytes, ...Array.from({ length: 24 }, (_, i) => i)]).toString(
    "base64"
  )

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0x1c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]

test("each image format is read off its own magic bytes", () => {
  assert.equal(sniffImageMimeType(base64Of(PNG)), "image/png")
  assert.equal(sniffImageMimeType(base64Of(JPEG)), "image/jpeg")
  assert.equal(sniffImageMimeType(base64Of(GIF)), "image/gif")
  assert.equal(sniffImageMimeType(base64Of(WEBP)), "image/webp")
})

test("a RIFF container that is not WEBP is not called one", () => {
  const wave = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]
  assert.equal(sniffImageMimeType(base64Of(wave)), DEFAULT_IMAGE_MIME)
})

test("anything unrecognised falls back rather than failing the turn", () => {
  assert.equal(sniffImageMimeType(""), DEFAULT_IMAGE_MIME)
  assert.equal(sniffImageMimeType("not base64 at all!!"), DEFAULT_IMAGE_MIME)
  assert.equal(sniffImageMimeType(base64Of([1, 2, 3, 4])), DEFAULT_IMAGE_MIME)
})

test("whitespace and the url-safe alphabet decode the same", () => {
  const plain = base64Of(PNG)
  const wrapped = `${plain.slice(0, 4)}\n  ${plain.slice(4)}`
  assert.equal(sniffImageMimeType(wrapped), "image/png")
  assert.equal(
    sniffImageMimeType(plain.replace(/\+/g, "-").replace(/\//g, "_")),
    "image/png"
  )
})

test("a real one-pixel PNG is a PNG", () => {
  // The 1x1 transparent PNG the tests and the docs both use.
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  assert.equal(sniffImageMimeType(pixel), "image/png")
})
