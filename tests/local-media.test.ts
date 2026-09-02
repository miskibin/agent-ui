import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isLocalPath,
  linkLocalImages,
  localFileUrl,
  localFileUrlFrom,
  localFilesInMarkdown,
  localPathFromUrl,
  resolveLocalPath,
} from "@/lib/local-media"
import { appendTextPart, textFromParts } from "@/lib/message-stream"
import type { MessagePart } from "@/components/ui/message"

/**
 * The rewrite that makes a picture an agent wrote visible in the chat. Two
 * properties are load-bearing: only *image* targets are rewritten (a link must
 * stay a link, or clicking it navigates away from the chat), and the rewrite
 * is idempotent, because the streaming reducer re-runs it over the accumulated
 * answer on every delta.
 */

test("a local image target becomes a route URL, spaces and all", () => {
  assert.equal(
    linkLocalImages("![chart](C:\\Users\\me\\Agent UI\\wykres.png)"),
    "![chart](/api/files?path=C%3A%5CUsers%5Cme%5CAgent%20UI%5Cwykres.png)"
  )
  assert.equal(
    linkLocalImages("![](/home/me/out/plot.png)"),
    "![](/api/files?path=%2Fhome%2Fme%2Fout%2Fplot.png)"
  )
  assert.equal(
    linkLocalImages("![](~/out/plot.png)"),
    "![](/api/files?path=~%2Fout%2Fplot.png)"
  )
})

test("a title after the target is kept outside the URL", () => {
  assert.equal(
    linkLocalImages('![c](/home/me/plot.png "The plot")'),
    '![c](/api/files?path=%2Fhome%2Fme%2Fplot.png "The plot")'
  )
})

test("an angle-bracketed target loses the brackets and keeps the path", () => {
  assert.equal(
    linkLocalImages("![c](</home/me/a b.png>)"),
    "![c](/api/files?path=%2Fhome%2Fme%2Fa%20b.png)"
  )
})

test("remote, relative and non-image targets are left exactly as they are", () => {
  const untouched = [
    "![c](https://example.com/a.png)",
    "![c](data:image/png;base64,AAAA)",
    "![c](./out/plot.png)",
    "[a link](/home/me/plot.png)",
    "no images here",
  ]
  for (const markdown of untouched) {
    assert.equal(linkLocalImages(markdown), markdown)
  }
  // Text with no image at all keeps its identity, so a memoized row does not
  // re-render for a no-op rewrite.
  const plain = "no images here"
  assert.ok(linkLocalImages(plain) === plain)
})

test("rewriting twice changes nothing the second time", () => {
  const once = linkLocalImages("![c](/home/me/plot.png)")
  assert.equal(linkLocalImages(once), once)
})

test("a path arriving in pieces is only rewritten once it closes", () => {
  let parts: MessagePart[] = []
  for (const chunk of ["Here it is:\n\n![chart](/home/me/", "out/plot", ".png)"]) {
    parts = appendTextPart(parts, chunk)
  }
  assert.equal(
    textFromParts(parts),
    "Here it is:\n\n![chart](/api/files?path=%2Fhome%2Fme%2Fout%2Fplot.png)"
  )
})

test("isLocalPath knows a place on this machine from a URL", () => {
  for (const local of ["/home/me/a.png", "C:\\x\\a.png", "c:/x/a.png", "~/a.png", "\\\\nas\\a.png"]) {
    assert.equal(isLocalPath(local), true, local)
  }
  for (const remote of ["https://x/a.png", "./a.png", "out/a.png", "a.png"]) {
    assert.equal(isLocalPath(remote), false, remote)
  }
})

test("a relative path a tool named is joined with the chat's folder", () => {
  assert.equal(
    localFileUrlFrom("out/plot.png", "/home/me/project"),
    localFileUrl("/home/me/project/out/plot.png")
  )
  // The folder's own spelling decides the separator.
  assert.equal(
    localFileUrlFrom("out\\plot.png", "D:\\work\\project\\"),
    localFileUrl("D:\\work\\project\\out\\plot.png")
  )
  // An absolute path ignores the folder; a relative one without a folder has
  // no URL at all.
  assert.equal(localFileUrlFrom("/tmp/a.png", "/home/me"), localFileUrl("/tmp/a.png"))
  assert.equal(localFileUrlFrom("out/plot.png"), undefined)
  assert.equal(localFileUrlFrom("   "), undefined)
})

test("resolveLocalPath joins the same way but keeps a bare name when it cannot", () => {
  assert.equal(resolveLocalPath("out/plot.png", "/home/me"), "/home/me/out/plot.png")
  assert.equal(resolveLocalPath("/tmp/a.png", "/home/me"), "/tmp/a.png")
  assert.equal(resolveLocalPath("out/plot.png"), "out/plot.png")
})

test("the route URL round-trips back to the path it serves", () => {
  const path = "C:\\Users\\me\\Agent UI\\wykres.png"
  assert.equal(localPathFromUrl(localFileUrl(path)), path)
  assert.equal(localPathFromUrl("/not/a/route/url"), "/not/a/route/url")
  assert.deepEqual(localFilesInMarkdown(linkLocalImages(`![c](${path})`)), [path])
  assert.deepEqual(localFilesInMarkdown("![c](https://x/a.png)"), [])
})
