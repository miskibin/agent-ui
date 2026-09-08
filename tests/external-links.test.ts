import assert from "node:assert/strict"
import { test } from "node:test"

import { externalUrl, isPlainClick } from "@/lib/external-links"

/**
 * Which clicks the desktop shell takes off the webview and hands to the system
 * browser. Two properties matter: nothing the app routes itself is claimed
 * (or a click on `/settings` would open a second copy of the app in Safari),
 * and every gesture that already means something to the browser is left alone.
 */

const ORIGIN = "http://127.0.0.1:41321"

const CLICK = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
}

test("an absolute http(s) link on another origin leaves", () => {
  assert.equal(
    externalUrl("https://docs.example.com/guide", ORIGIN),
    "https://docs.example.com/guide"
  )
  assert.equal(externalUrl("http://example.com/", ORIGIN), "http://example.com/")
})

test("mailto and tel leave too — the webview cannot serve either", () => {
  assert.equal(externalUrl("mailto:me@example.com", ORIGIN), "mailto:me@example.com")
  assert.equal(externalUrl("tel:+15551234", ORIGIN), "tel:+15551234")
})

test("the app's own origin stays in the window it is already in", () => {
  assert.equal(externalUrl(`${ORIGIN}/settings`, ORIGIN), null)
  // An in-page anchor resolves to this origin on the element's `href`.
  assert.equal(externalUrl(`${ORIGIN}/#section`, ORIGIN), null)
  // As does a file the panel links to through the app's own route.
  assert.equal(externalUrl(`${ORIGIN}/api/files?path=%2Ftmp%2Fa.png`, ORIGIN), null)
})

test("the app's own plumbing is not a browser's business", () => {
  assert.equal(externalUrl("file:///etc/passwd", ORIGIN), null)
  assert.equal(externalUrl("data:image/png;base64,AAAA", ORIGIN), null)
  assert.equal(externalUrl("blob:http://localhost/abc", ORIGIN), null)
  assert.equal(externalUrl("javascript:alert(1)", ORIGIN), null)
  assert.equal(externalUrl("agent-ui://quit-requested", ORIGIN), null)
})

test("a non-URL href is nothing to open", () => {
  assert.equal(externalUrl("", ORIGIN), null)
  assert.equal(externalUrl("not a url", ORIGIN), null)
})

test("only a plain left click is the app's to claim", () => {
  assert.equal(isPlainClick(CLICK), true)
  assert.equal(isPlainClick({ ...CLICK, button: 1 }), false)
  assert.equal(isPlainClick({ ...CLICK, metaKey: true }), false)
  assert.equal(isPlainClick({ ...CLICK, ctrlKey: true }), false)
  assert.equal(isPlainClick({ ...CLICK, shiftKey: true }), false)
  assert.equal(isPlainClick({ ...CLICK, altKey: true }), false)
  assert.equal(isPlainClick({ ...CLICK, defaultPrevented: true }), false)
})
