"use client"

import { toast } from "sonner"

export async function copyText(
  text: string,
  success = "Copied"
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(success)
  } catch {
    toast.error("Could not copy. Check clipboard permissions and try again.")
  }
}
