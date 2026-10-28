#!/usr/bin/env node
/**
 * Regenerates `components/brand-marks.ts` from `@lobehub/icons-static-svg`
 * (MIT, https://github.com/lobehub/lobe-icons): a brand's colour variant where
 * the package has one, its monochrome mark where it does not — OpenAI, Ollama
 * or Cursor are black-and-white brands, and their mark is drawn in
 * `currentColor` so it follows the theme.
 *
 *   node scripts/import-brand-marks.mjs
 *
 * The package tarball is fetched from the npm registry and read in memory —
 * no subprocess, no temporary folder, nothing added to the app's dependencies. Adding a mark is one slug in CURATED
 * plus a rerun; which model or harness resolves to it lives in
 * `lib/model-brand.ts`.
 *
 * A colour mark is rebuilt as an element tree — `[tag, props, ...children]`,
 * from an allow-list of elements and attributes, props already in React's
 * spelling — so the page renders elements and never injects markup. Its
 * gradient ids become
 * `__ID__<n>` for the renderer to make unique per instance, and pure black
 * becomes `currentColor` — black ink on a dark theme is no mark at all.
 */

import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "components/brand-marks.ts")
const PACKAGE = "@lobehub/icons-static-svg"
const REGISTRY = "https://registry.npmjs.org"

/** Model families, then model sources, then harnesses. */
const CURATED = [
  // Model families
  "openai", "claude", "gemini", "gemma", "deepseek", "qwen", "meta", "mistral",
  "grok", "kimi", "zai", "minimax", "cohere", "nvidia", "microsoft", "ibm",
  "yi", "baichuan", "stepfun", "hunyuan", "doubao", "ai21", "perplexity", "tii",
  "liquid", "ai2", "upstage", "huggingface", "longcat", "wenxin", "deepcogito",
  "baai",
  // Model sources
  "anthropic", "google", "xai", "openrouter", "ollama", "groq", "together",
  "fireworks", "cerebras", "deepinfra", "lmstudio", "vllm", "azure", "bedrock",
  "vertexai", "novita", "nebius", "sambanova", "hyperbolic", "siliconcloud",
  "moonshot", "alibaba",
  // Harnesses
  "claudecode", "codex", "cursor", "geminicli", "opencode", "githubcopilot",
  "cline", "goose", "roocode", "kilocode", "openhands", "windsurf", "amp",
  "kiro", "pi",
]

const attrs = (source) =>
  Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))

/** An `<ellipse>`/`<circle>` as two arcs, so every mark is paths alone. */
function ellipsePath({ cx, cy, rx, ry, r }) {
  const [x, y] = [Number(cx), Number(cy)]
  const [a, b] = [Number(rx ?? r), Number(ry ?? r)]
  return `M${x - a} ${y}a${a} ${b} 0 1 0 ${2 * a} 0a${a} ${b} 0 1 0 ${-2 * a} 0Z`
}

function parse(slug, svg) {
  const root = svg.match(/<svg[^>]*>/)?.[0] ?? ""
  if (!root.includes('viewBox="0 0 24 24"') || !root.includes('fill-rule="evenodd"')) {
    throw new Error(`${slug}: expected a 24x24 evenodd mark`)
  }
  const title = svg.match(/<title>(.*?)<\/title>/)?.[1] ?? slug
  const paths = []
  for (const [, tag, rest] of svg.matchAll(/<(path|ellipse|circle)\b([^>]*?)\/?>/g)) {
    const a = attrs(rest)
    const d = tag === "path" ? a.d : ellipsePath(a)
    const opacity = a["fill-opacity"] ?? a.opacity
    paths.push(opacity ? [d, Number(opacity)] : d)
  }
  if (/<(g|rect|polygon|mask|defs|use|linearGradient)\b/.test(svg)) {
    throw new Error(`${slug}: carries an element this importer does not read`)
  }
  return { title, paths }
}

const COLOR_ELEMENTS = new Set([
  "g", "path", "circle", "ellipse", "rect", "defs", "linearGradient",
  "radialGradient", "stop",
])
const COLOR_ATTRIBUTES = new Set([
  "d", "fill", "fill-rule", "clip-rule", "fill-opacity", "opacity", "stroke",
  "stroke-width", "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height",
  "x1", "x2", "y1", "y2", "fx", "fy", "offset", "stop-color", "stop-opacity",
  "gradientUnits", "gradientTransform", "transform", "id",
])
const BLACK = /^#(?:000|000000)$/i

function parseColor(slug, svg) {
  const root = attrs(svg.match(/<svg([^>]*)>/)?.[1] ?? "")
  if (root.viewBox !== "0 0 24 24") throw new Error(`${slug}-color: expected 24x24`)
  const body = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
  const ids = new Map()
  for (const [, id] of body.matchAll(/\bid="([^"]+)"/g)) ids.set(id, `__ID__${ids.size}`)

  // The root's own paint moves onto a group; unpainted shapes take the ink.
  const group = { fill: root.fill && !BLACK.test(root.fill) ? root.fill : "currentColor" }
  if (root["fill-rule"]) group.fillRule = root["fill-rule"]
  const tree = ["g", group]
  const stack = [tree]
  for (const [token, close, tag, rest, selfClose] of body.matchAll(
    /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g
  )) {
    if (!COLOR_ELEMENTS.has(tag)) throw new Error(`${slug}-color: <${tag}> in ${token}`)
    if (close) {
      if (stack.pop()?.[0] !== tag) throw new Error(`${slug}-color: unbalanced </${tag}>`)
      continue
    }
    const props = {}
    for (const [name, raw] of Object.entries(attrs(rest))) {
      if (!COLOR_ATTRIBUTES.has(name)) throw new Error(`${slug}-color: ${name}=`)
      let value = raw
      if (name === "id") value = ids.get(raw)
      value = value.replace(/url\(#([^)]+)\)/g, (_, id) => {
        if (!ids.has(id)) throw new Error(`${slug}-color: unknown url(#${id})`)
        return `url(#${ids.get(id)})`
      })
      if ((name === "fill" || name === "stop-color") && BLACK.test(value)) value = "currentColor"
      props[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    }
    const node = [tag, props]
    stack.at(-1).push(node)
    if (!selfClose) stack.push(node)
  }
  if (stack.length !== 1) throw new Error(`${slug}-color: unclosed element`)
  return tree
}

/** A ustar archive's regular files, by path. Enough of tar for an npm tarball. */
function untar(archive) {
  const files = new Map()
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "")
    if (!name) break
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "")
    const size = parseInt(header.subarray(124, 136).toString("utf8").trim() || "0", 8)
    const type = String.fromCharCode(header[156] || 48)
    const body = archive.subarray(offset + 512, offset + 512 + size)
    if (type === "0") files.set(prefix ? `${prefix}/${name}` : name, body.toString("utf8"))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function fetchPackage() {
  const meta = await fetch(`${REGISTRY}/${PACKAGE}/latest`)
  if (!meta.ok) throw new Error(`${PACKAGE}: registry answered ${meta.status}`)
  const { version, dist } = await meta.json()
  const tarball = await fetch(dist.tarball)
  if (!tarball.ok) throw new Error(`${PACKAGE}: tarball answered ${tarball.status}`)
  return { version, files: untar(gunzipSync(Buffer.from(await tarball.arrayBuffer()))) }
}

{
  const { version, files } = await fetchPackage()
  const icon = (name) => files.get(`package/icons/${name}`) ?? null

  const entries = []
  const colorEntries = []
  for (const slug of CURATED) {
    const color = icon(`${slug}-color.svg`)
    if (color) {
      const title = color.match(/<title>(.*?)<\/title>/)?.[1] ?? slug
      colorEntries.push(`  // ${title}\n  ${slug}:\n    ${JSON.stringify(parseColor(slug, color))},`)
      continue
    }
    const svg = icon(`${slug}.svg`)
    if (!svg) throw new Error(`${slug}: no such icon in ${PACKAGE}@${version}`)
    const { title, paths } = parse(slug, svg)
    const body = paths.map((p) => `    ${JSON.stringify(p)},`).join("\n")
    entries.push(`  // ${title}\n  ${slug}: [\n${body}\n  ],`)
  }

  await writeFile(
    OUT,
    `// Generated by scripts/import-brand-marks.mjs from ${PACKAGE}@${version}
// (MIT, https://github.com/lobehub/lobe-icons). Do not edit by hand.

/** One path of a mark: its \`d\`, or \`[d, fillOpacity]\`. */
export type BrandMarkPath = string | readonly [string, number]

/**
 * Monochrome brands: 24x24 \`currentColor\` path data, drawn with
 * \`fill-rule="evenodd"\`.
 */
export const BRAND_MARKS: Record<string, readonly BrandMarkPath[]> = {
${entries.join("\n")}
}

/** \`[tag, props, ...children]\`, props in React's spelling. */
export type BrandMarkNode = readonly [
  tag: string,
  props: Readonly<Record<string, string>>,
  ...children: BrandMarkNode[],
]

/**
 * Brands in their own colours: what goes inside a 24x24 \`<svg>\`, rebuilt
 * from an allow-list of elements and attributes. \`__ID__\` prefixes every
 * gradient id so each instance on a page can make its own unique.
 */
export const BRAND_COLOR_MARKS: Record<string, BrandMarkNode> = {
${colorEntries.join("\n")}
}
`
  )
  console.log(`wrote ${colorEntries.length} colour and ${entries.length} monochrome marks to ${OUT}`)
}
