"use client"

import * as React from "react"
import { ChevronRight, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import {
  isValidMemoryName,
  MAX_MEMORY_DESCRIPTION_CHARS,
  MAX_MEMORY_FILE_CHARS,
  MAX_MEMORY_FILES,
  memoryLines,
  SUGGESTED_MEMORY_FILES,
  toMemoryName,
  type MemoryFile,
} from "@/lib/memory/types"
import { MEMORY_BUDGET_RANGE, type AppSettings } from "@/lib/settings/schema"
import { cn } from "@/lib/utils"

import { SettingsRow, SettingsSection } from "./section"
import type { AppSettingsApi } from "./use-app-settings"
import { useMemoryStore, type MemoryFileDraft } from "./use-memory-store"

/** How long "Forget everything" stays armed before it disarms itself. */
const CONFIRM_TIMEOUT = 5000

/**
 * One topic file, collapsed to its description until opened. The name is
 * editable too: it is the file name, so changing it renames the file.
 */
function MemoryFileRow({
  file,
  busy,
  onSave,
  onDelete,
}: {
  file: MemoryFile
  busy: boolean
  onSave: (draft: MemoryFileDraft, previousName?: string) => Promise<boolean>
  onDelete: (name: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState(file.name)
  const [description, setDescription] = React.useState(file.description)
  const [content, setContent] = React.useState(file.content)

  // Reopening a row shows what is on disk now — an agent may have rewritten
  // the file since the draft was taken.
  const reset = React.useCallback(() => {
    setName(file.name)
    setDescription(file.description)
    setContent(file.content)
  }, [file.name, file.description, file.content])

  const toggle = React.useCallback(() => {
    setOpen((current) => {
      if (!current) reset()
      return !current
    })
  }, [reset])

  const dirty =
    name !== file.name || description !== file.description || content !== file.content
  const valid =
    isValidMemoryName(name) &&
    description.trim().length > 0 &&
    content.length <= MAX_MEMORY_FILE_CHARS
  const lines = memoryLines(file.content).length

  const commit = React.useCallback(async () => {
    const ok = await onSave(
      { name, description, content },
      name !== file.name ? file.name : undefined
    )
    if (ok) setOpen(false)
  }, [onSave, name, description, content, file.name])

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
          <span className="shrink-0 font-mono text-[12px] font-medium text-foreground">
            {file.name}
          </span>
          <span className="truncate text-[12px] text-muted-foreground">
            {file.description}
          </span>
        </button>
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {lines} {lines === 1 ? "line" : "lines"}
        </span>
      </div>

      {open ? (
        <div className="mt-3 flex flex-col gap-2.5 pl-5.5">
          <div className="flex items-center gap-2">
            <label
              htmlFor={`memory-name-${file.name}`}
              className="w-20 shrink-0 text-[12px] text-muted-foreground"
            >
              Name
            </label>
            <Input
              id={`memory-name-${file.name}`}
              value={name}
              /* Lower-cased as you type, but not slugged: `toMemoryName`
                 strips trailing dashes, which makes `my-notes` untypable. The
                 slug is applied on blur, once the name is finished. */
              onChange={(event) => setName(event.target.value.toLowerCase())}
              onBlur={() => setName(toMemoryName(name))}
              aria-invalid={!isValidMemoryName(name)}
              className="h-8 w-56 font-mono text-[12px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <label
              htmlFor={`memory-description-${file.name}`}
              className="w-20 shrink-0 text-[12px] text-muted-foreground"
            >
              Description
            </label>
            <Input
              id={`memory-description-${file.name}`}
              value={description}
              maxLength={MAX_MEMORY_DESCRIPTION_CHARS}
              onChange={(event) => setDescription(event.target.value)}
              aria-invalid={!description.trim()}
              className="h-8 text-[12.5px]"
            />
          </div>

          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
            aria-label={`${file.name} contents`}
            aria-invalid={content.length > MAX_MEMORY_FILE_CHARS}
            rows={Math.min(16, Math.max(5, content.split("\n").length + 1))}
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
          />

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !dirty || !valid}
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
            <span
              className={cn(
                "font-mono text-[11px] tabular-nums text-muted-foreground",
                content.length > MAX_MEMORY_FILE_CHARS && "text-destructive"
              )}
            >
              {content.length}/{MAX_MEMORY_FILE_CHARS}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onDelete(file.name)}
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
  const [newName, setNewName] = React.useState("")
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

  const addFile = React.useCallback(async () => {
    const name = toMemoryName(newName)
    if (!isValidMemoryName(name)) {
      toast.error("Use lowercase letters, digits and dashes.")
      return
    }
    if (store.files.some((file) => file.name === name)) {
      toast.error(`"${name}" already exists.`)
      return
    }
    const suggested = SUGGESTED_MEMORY_FILES.find((entry) => entry.name === name)
    const ok = await store.save({
      name,
      description: suggested?.description ?? name.replace(/-/g, " "),
      content: "",
    })
    if (ok) setNewName("")
  }, [newName, store])

  const full = store.files.length >= MAX_MEMORY_FILES

  return (
    <SettingsSection
      id="memory"
      title="Memory"
      description="A few markdown files about you that every agent is shown. The agent keeps them itself, like Claude Code does: it adds what you tell it to remember, updates the file a topic already lives in, and deletes what turns out wrong or outdated."
    >
      <SettingsRow
        title="Remember across chats"
        htmlFor="memory-enabled"
        description="Off by default. What is remembered here is sent to every backend you chat with afterwards, including ones that never heard it."
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
        <SettingsRow
          title="Per-turn budget"
          description="Characters of file contents sent with a new conversation. The list of files is always sent; a file that does not fit is read on demand by agents that have tools."
          control={
            <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
              {store.bytes} stored · {memory.maxChars} per turn
            </span>
          }
        >
          <Slider
            value={[memory.maxChars]}
            min={MEMORY_BUDGET_RANGE.min}
            max={MEMORY_BUDGET_RANGE.max}
            step={500}
            onValueChange={([maxChars]) => setMemory({ maxChars })}
            aria-label="Memory characters per turn"
          />
        </SettingsRow>
      ) : null}

      <SettingsRow
        title="What's remembered"
        description={`${
          store.dir ? `Files in ${store.dir}. ` : ""
        }At most ${MAX_MEMORY_FILES} files of ${MAX_MEMORY_FILE_CHARS} characters, so memory stays a handful of current notes rather than a log. Claude Code edits them through the app's memory tools; other agents with file tools edit the files directly.`}
        control={
          <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
            {store.files.length}/{MAX_MEMORY_FILES} files
          </span>
        }
      />

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
              ? "Tell an agent something about how you work and it will save it."
              : "Turn memory on, or add a file below to write notes by hand."}
          </p>
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            Suggested files:{" "}
            {SUGGESTED_MEMORY_FILES.map((entry) => entry.name).join(", ")}.
          </p>
        </div>
      ) : (
        store.files.map((file) => (
          <MemoryFileRow
            key={file.name}
            file={file}
            busy={store.saving === file.name}
            onSave={store.save}
            onDelete={store.remove}
          />
        ))
      )}

      <SettingsRow title="Add a file">
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void addFile()
              }
            }}
            disabled={full}
            placeholder={full ? "Limit reached — merge files first" : "preferences, stack, workflow…"}
            className="h-8 max-w-64 text-[12.5px]"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={full || !newName.trim()}
            onClick={() => void addFile()}
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
                  Delete every file
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
