// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

import "server-only"

import { open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Replace a file's contents durably, or leave the old contents alone.
 *
 * A plain `writeFile` + `rename` is already atomic for a *reader*: the rename
 * is, so nobody ever sees half a file. It is not durable for the *machine*.
 * The bytes may still be in the page cache when the power goes, and what
 * survives is then a renamed-into-place file of zeroes — the failure mode the
 * rename was supposed to prevent, with the old contents already gone.
 *
 * So four things happen in order, and the order is the whole point:
 *
 * 1. the temp file is opened `wx` (never clobber a concurrent writer's temp)
 *    and 0o600 — it briefly holds the same secrets as the file it replaces;
 * 2. it is written and `fsync`ed, so the data is on the disk before anything
 *    points at it;
 * 3. it is renamed over the target;
 * 4. the *directory* is fsynced, so the rename itself survives a crash.
 *
 * Windows has no directory fsync: the handle opens and `sync` fails EPERM,
 * which is swallowed because NTFS journals the rename on its own. The temp
 * file is removed in `finally` either way, so a failed write leaves no litter.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
  options: { mode?: number } = {}
): Promise<void> {
  const directory = dirname(filePath)
  const tempPath = `${filePath}.${process.pid.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, "wx", options.mode ?? 0o600)
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tempPath, filePath)
    await syncDirectory(directory)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Flushes the directory entry so the rename above outlives a power cut.
 * Windows cannot do this at all — the open succeeds and the sync answers
 * EPERM — and NTFS does not need it, so that one error is not an error.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, "r")
    await handle.sync()
  } catch {
    // The rename has already landed, so a directory that cannot be flushed
    // costs durability, never correctness — and on Windows it is not even
    // that. Nothing here is worth failing a settled write over.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
