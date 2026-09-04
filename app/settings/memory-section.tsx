"use client"

import * as React from "react"
import { ChevronRight, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import * as api from "@/lib/api-client"
import {
  DEFAULT_MEMORY_CATEGORIES,
  isValidMemoryCategory,
  memoryFactLines,
  memoryTitleFrom,
  toMemoryCategoryId,
  withMemoryHeading,
  type MemoryFile,
} from "@/lib/memory/types"
import { MEMORY_BUDGET_RANGE, type AppSettings } from "@/lib/settings/schema"
import { cn } from "@/lib/utils"

import { SettingsRow, SettingsSection } from "./section"
import type { AppSettingsApi } from "./use-app-settings"
import { useMemoryStore } from "./use-memory-store"


/** How long "Forget everything" stays armed before it disarms itself. */
const CONFIRM_TIMEOUT = 5000

function factCount(file: MemoryFile) {
  return memoryFactLines(file.content).filter((line) => !line.startsWith("#"))
    .length
}

/**
 * One category, collapsed to a summary until opened. Both the id and the body
 * are editable: the id is the file name, so changing it is how a fact gets
 * moved to a different category — the row writes the new file and drops the
 * old one in the same save.
 */
function MemoryFileRow({
  file,
  busy,
  onSave,
  onRename,
  onDelete,
}: {
  file: MemoryFile
  busy: boolean
  onSave: (category: string, content: string) => Promise<boolean>
  onRename: (from: string, to: string, content: string) => Promise<boolean>
  onDelete: (category: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(file.content)
  const [category, setCategory] = React.useState(file.category)

  // Reopening a row shows what is on disk now, not a stale draft from before
  // an extraction pass rewrote the file underneath it.
  const reset = React.useCallback(() => {
    setDraft(file.content)
    setCategory(file.category)
  }, [file.content, file.category])

  const toggle = React.useCallback(() => {
    setOpen((current) => {
      if (!current) reset()
      return !current
    })
  }, [reset])

  const dirty = draft !== file.content || category !== file.category
  const renaming = category !== file.category
  const idValid = isValidMemoryCategory(category)

  const commit = React.useCallback(async () => {
    const ok = renaming
      ? await onRename(file.category, category, draft)
      : await onSave(file.category, draft)
    if (ok) setOpen(false)
  }, [renaming, onRename, onSave, file.category, category, draft])

  return (
    <div data-slot="memory-file" className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          <span className="truncate text-[13px] font-medium text-foreground">
            {file.title}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {file.category}
          </span>
        </button>
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {factCount(file)} {factCount(file) === 1 ? "fact" : "facts"}
        </span>
      </div>

      {open ? (
        <div className="mt-3 flex flex-col gap-2.5 pl-5.5">
          <div className="flex items-center gap-2">
            <label
              htmlFor={`memory-category-${file.category}`}
              className="text-[12px] text-muted-foreground"
            >
              Category
            </label>
            <Input
              id={`memory-category-${file.category}`}
              value={category}
              /* Lower-cased as you type, but not slugged: `toMemoryCategoryId`
                 strips trailing dashes, which makes `my-notes` untypable. The
                 slug is applied on blur, once the name is finished. */
              onChange={(event) => setCategory(event.target.value.toLowerCase())}
              onBlur={() => setCategory(toMemoryCategoryId(category))}
              aria-invalid={!idValid}
              className="h-8 w-56 font-mono text-[12px]"
            />
            {renaming && idValid ? (
              <span className="text-[11.5px] text-muted-foreground">
                moves these facts to {category}.md
              </span>
            ) : null}
          </div>

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            rows={Math.min(16, Math.max(5, draft.split("\n").length + 1))}
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
          />

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !dirty || !idValid}
              onClick={() => void commit()}
              className="text-[12.5px]"
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                reset()
                setOpen(false)
              }}
              className="text-[12.5px]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onDelete(file.category)}
              className="ml-auto text-[12.5px] text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function MemorySection({ settings, loaded, update }: AppSettingsApi) {
  const memory = settings.memory
  const store = useMemoryStore()
  const [models, setModels] = React.useState<
    { id: string; name: string }[] | null
  >(null)
  const [newCategory, setNewCategory] = React.useState("")
  // Same arm-then-confirm as Settings → Data: this shreds every note in one
  // click, and the files are the only copy.
  const [armed, setArmed] = React.useState(false)

  React.useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT)
    return () => clearTimeout(timer)
  }, [armed])

  const setMemory = React.useCallback(
    (patch: Partial<AppSettings["memory"]>) =>
      update((current) => ({
        ...current,
        memory: { ...current.memory, ...patch },
      })),
    [update]
  )

  // The extraction model list is Ollama's, whatever the chat is pointed at —
  // this step always runs locally.
  React.useEffect(() => {
    let cancelled = false
    api
      .fetchModels("ollama")
      .then((res) => {
        if (!cancelled) setModels(res.models.map(({ id, name }) => ({ id, name })))
      })
      .catch(() => {
        if (!cancelled) setModels([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const addCategory = React.useCallback(async () => {
    const id = toMemoryCategoryId(newCategory)
    if (!isValidMemoryCategory(id)) {
      toast.error("Use lowercase letters, digits and dashes.")
      return
    }
    if (store.files.some((file) => file.category === id)) {
      toast.error(`"${id}" already exists.`)
      return
    }
    const title = id
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
    const ok = await store.save(id, `# ${title}\n`)
    if (ok) setNewCategory("")
  }, [newCategory, store])

  const rename = React.useCallback(
    async (from: string, to: string, content: string) => {
      if (store.files.some((file) => file.category === to)) {
        toast.error(`"${to}" already exists — merge them by hand instead.`)
        return false
      }
      /* The heading is the category's display name, so it has to move with it;
         left alone, `stack.md` renamed to `tooling` still reads "Stack" here
         and in every prompt. */
      const retitled = withMemoryHeading(content, memoryTitleFrom(to, ""))
      if (!(await store.save(to, retitled))) return false
      /* Write first, then drop the original — and only if the drop succeeds,
         because a failed delete would leave the same facts under both names. */
      if (!(await store.remove(from))) {
        toast.error(`Renamed, but "${from}" is still there — delete it by hand.`)
      }
      return true
    },
    [store]
  )

  const overBudget = store.bytes > memory.maxChars

  /**
   * Why the extraction step would do nothing, said in the page's own terms.
   * Composed from the settings this component holds — which are current — plus
   * the one fact only the server knows, whether Ollama answers.
   */
  const blocker = !memory.enabled
    ? undefined
    : !memory.model
      ? "No extraction model chosen."
      : !store.ollamaEnabled
        ? "Ollama is disabled in Harnesses."
        : !store.ollamaReachable && !store.loading
          ? `No Ollama server at ${store.ollamaBaseUrl || "an unset URL"}.`
          : undefined

  return (
    <SettingsSection
      id="memory"
      title="Memory"
      description="Durable preferences carried into every new conversation, extracted by a local model from what you type."
    >
      <SettingsRow
        title="Remember preferences"
        htmlFor="memory-enabled"
        description="Off by default. What is learned here is sent to every backend you chat with afterwards, including ones that never heard it."
        control={
          loaded ? (
            <Switch
              id="memory-enabled"
              checked={memory.enabled}
              onCheckedChange={(enabled) => setMemory({ enabled })}
            />
          ) : (
            <Skeleton className="h-5 w-9" />
          )
        }
      />

      {memory.enabled ? (
        <>
          <SettingsRow
            title="Extraction model"
            description="A small local model reads your messages after each turn and updates the notes. It never sees the agent's replies, tool calls, or any file."
            control={
              models === null ? (
                <Skeleton className="h-8 w-52" />
              ) : models.length === 0 ? (
                <span className="text-[12px] text-muted-foreground">
                  No Ollama models
                </span>
              ) : (
                <Select
                  value={memory.model}
                  onValueChange={(model) => setMemory({ model })}
                >
                  <SelectTrigger size="sm" className="w-52 text-[12.5px]">
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            }
          />

          <SettingsRow
            title="Update after every turn"
            htmlFor="memory-auto"
            description="Runs the extraction in the background once an answer settles. Off means the notes only change when you edit them here."
            control={
              <Switch
                id="memory-auto"
                checked={memory.autoUpdate}
                onCheckedChange={(autoUpdate) => setMemory({ autoUpdate })}
              />
            }
          />

          <SettingsRow
            title="Remember sensitive topics"
            htmlFor="memory-sensitive"
            description="Health, ethnicity, religion, politics and gender identity are skipped unless you turn this on. Identity numbers, payment details and credentials are never stored either way."
            control={
              <Switch
                id="memory-sensitive"
                checked={memory.includeSensitive}
                onCheckedChange={(includeSensitive) =>
                  setMemory({ includeSensitive })
                }
              />
            }
          />

          <SettingsRow
            title="Size budget"
            description="Everything remembered fits in this many characters, so it all goes into the prompt and nothing has to be searched for. Going over it makes the extractor merge and shorten rather than keep adding."
            control={
              <span
                className={cn(
                  "font-mono text-[12px] tabular-nums",
                  overBudget ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {store.bytes} / {memory.maxChars}
              </span>
            }
          >
            <Slider
              value={[memory.maxChars]}
              min={MEMORY_BUDGET_RANGE.min}
              max={MEMORY_BUDGET_RANGE.max}
              step={250}
              onValueChange={([maxChars]) => setMemory({ maxChars })}
              aria-label="Memory size budget in characters"
            />
          </SettingsRow>
        </>
      ) : null}

      <SettingsRow
        title="What's remembered"
        description={
          store.dir
            ? `One markdown file per category in ${store.dir}. Edit them freely — this is exactly what the agent is handed.`
            : "One markdown file per category, editable here."
        }
      >
        {blocker ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-[12px] text-muted-foreground">
            {blocker} Nothing will be extracted until that&apos;s fixed — the
            notes below are still used in every chat.
          </p>
        ) : null}
      </SettingsRow>

      {store.loading ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-32" />
        </div>
      ) : store.files.length === 0 ? (
        <div className="px-4 py-3.5">
          <p className="text-[12.5px] text-muted-foreground">
            Nothing remembered yet.{" "}
            {memory.enabled
              ? "Notes appear here as you chat."
              : "Turn memory on, or add a category below to write notes by hand."}
          </p>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            Suggested categories:{" "}
            {DEFAULT_MEMORY_CATEGORIES.map((entry) => entry.category).join(", ")}.
          </p>
        </div>
      ) : (
        store.files.map((file) => (
          <MemoryFileRow
            key={file.category}
            file={file}
            busy={store.saving === file.category}
            onSave={store.save}
            onRename={rename}
            onDelete={store.remove}
          />
        ))
      )}

      <SettingsRow title="Add a category">
        <div className="flex items-center gap-2">
          <Input
            value={newCategory}
            onChange={(event) => setNewCategory(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void addCategory()
              }
            }}
            placeholder="tone, deployment, editor…"
            className="h-8 max-w-64 text-[12.5px]"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!newCategory.trim()}
            onClick={() => void addCategory()}
            className="text-[12.5px]"
          >
            <Plus />
            Add
          </Button>
          {store.files.length > 0 &&
            (armed ? (
              <div className="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setArmed(false)}
                  className="text-[12.5px]"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setArmed(false)
                    void store.clear()
                  }}
                  className="text-[12.5px]"
                >
                  <Trash2 />
                  Delete every note
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setArmed(true)}
                className="ml-auto text-[12.5px] text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 />
                Forget everything
              </Button>
            ))}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
