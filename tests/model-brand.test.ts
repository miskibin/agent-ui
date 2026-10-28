import assert from "node:assert/strict"
import { test } from "node:test"

import { BRAND_COLOR_MARKS, BRAND_MARKS as MONO_MARKS } from "@/components/brand-marks"

const BRAND_MARKS = { ...MONO_MARKS, ...BRAND_COLOR_MARKS }
import { harnessBrand, modelBrand, modelFamily, sourceBrand } from "@/lib/model-brand"

/**
 * The mark a model, source or harness is drawn with. What a wrong answer would
 * hide: the family must win over where a model is served and over what it was
 * distilled from, and a short token must not fire inside an unrelated word.
 */

test("a family is read off the id wherever the model is served", () => {
  const cases: Array<[string, string]> = [
    ["qwen/qwen3.8-27b", "qwen"],
    ["openrouter/qwen/qwen3-coder", "qwen"],
    ["ollama/qwen3:8b", "qwen"],
    ["hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M", "qwen"],
    ["qwq:32b", "qwen"],
    ["anthropic/claude-sonnet-4.5", "claude"],
    ["sonnet", "claude"],
    ["opus", "claude"],
    ["openai/gpt-5.4", "openai"],
    ["gpt-oss:20b", "openai"],
    ["o3-mini", "openai"],
    ["o4-mini-high", "openai"],
    ["gpt-5-codex", "openai"],
    ["google/gemini-2.5-pro", "gemini"],
    ["gemma3:27b", "gemma"],
    ["deepseek-r1-distill-qwen-32b", "deepseek"],
    ["deepseek-chat", "deepseek"],
    ["meta-llama/llama-3.3-70b-instruct", "meta"],
    ["llama3.2-vision", "meta"],
    ["codellama:13b", "meta"],
    ["mistralai/devstral-small", "mistral"],
    ["mixtral:8x7b", "mistral"],
    ["x-ai/grok-4", "grok"],
    ["moonshotai/kimi-k2", "kimi"],
    ["z-ai/glm-4.6", "zai"],
    ["minimax/minimax-m2", "minimax"],
    ["command-r-plus", "cohere"],
    ["phi4-mini", "microsoft"],
    ["phi3.5:3.8b", "microsoft"],
    ["granite3.3:8b", "ibm"],
    ["yi:34b", "yi"],
    ["nvidia/llama-3.1-nemotron-70b", "nvidia"],
    ["composer-1", "cursor"],
  ]
  for (const [id, brand] of cases) assert.equal(modelFamily(id), brand, id)
})

test("a short token does not fire inside another word", () => {
  for (const id of ["tinyllama", "nomic-embed-text", "mxbai-embed-large", "dolphin3", "auto"]) {
    assert.equal(modelFamily(id), null, id)
  }
})

test("a model with no family falls back to its source", () => {
  assert.equal(modelBrand("ollama/dolphin3"), "ollama")
  assert.equal(modelBrand("nomic-embed-text", "ollama"), "ollama")
  assert.equal(modelBrand("groq/some-unknown-model"), "groq")
  assert.equal(modelBrand("custom/thing"), null)
  // The family still beats the source.
  assert.equal(modelBrand("groq/llama-3.3-70b"), "meta")
})

test("sources resolve by slug, alias or the family they are named after", () => {
  assert.equal(sourceBrand("openrouter"), "openrouter")
  assert.equal(sourceBrand("together-ai"), "together")
  assert.equal(sourceBrand("my-qwen-proxy"), "qwen")
  assert.equal(sourceBrand("litellm"), null)
})

test("harnesses resolve by id, then by an ACP agent's key and name", () => {
  assert.equal(harnessBrand("claudeCode"), "claudecode")
  assert.equal(harnessBrand("cursorAgent"), "cursor")
  assert.equal(harnessBrand("codex"), "codex")
  assert.equal(harnessBrand("acp:dsh"), "deepseek")
  assert.equal(harnessBrand("acp:gemini", "Gemini CLI"), "geminicli")
  assert.equal(harnessBrand("acp:claude", "Claude Code (ACP)"), "claudecode")
  assert.equal(harnessBrand("acp:oc", "OpenCode"), "opencode")
  assert.equal(harnessBrand("acp:qwen-code"), "qwen")
  assert.equal(harnessBrand("acp:tinyagent", "tinyagent"), null)
})

test("every slug the resolver can return has a mark", () => {
  const lucide = new Set(["chat", "mock"])
  const ids = [
    "claude", "gemma", "gemini", "gpt", "deepseek", "qwen", "llama", "mistral", "grok",
    "kimi", "glm", "minimax", "cohere", "nvidia", "phi", "granite", "yi", "baichuan",
    "stepfun", "hunyuan", "doubao", "jamba", "sonar", "falcon", "lfm", "olmo", "solar",
    "smollm", "longcat", "ernie", "cogito", "bge", "composer",
  ]
  for (const id of ids) {
    const brand = modelFamily(id)
    assert.ok(brand && brand in BRAND_MARKS, `${id} → ${brand}`)
  }
  for (const source of [
    "openai", "anthropic", "google", "xai", "deepseek", "mistral", "openrouter", "ollama",
    "groq", "together", "fireworks", "cerebras", "deepinfra", "lmstudio", "vllm", "azure",
    "bedrock", "vertexai", "novita", "nebius", "sambanova", "hyperbolic", "siliconcloud",
    "moonshot", "alibaba", "cohere", "nvidia", "perplexity", "huggingface", "zai", "qwen",
    "minimax",
  ]) {
    assert.ok(sourceBrand(source)! in BRAND_MARKS, source)
  }
  for (const id of ["claudeCode", "cursorAgent", "codex", "pi", "ollama", "chat", "mock"]) {
    const brand = harnessBrand(id)!
    assert.ok(brand in BRAND_MARKS || lucide.has(brand), id)
  }
  for (const key of [
    "gemini", "opencode", "copilot", "cline", "goose", "roo", "kilo", "openhands",
    "windsurf", "amp", "kiro",
  ]) {
    assert.ok(harnessBrand(`acp:${key}`)! in BRAND_MARKS, key)
  }
})
