import "server-only"

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

const FILTER =
  "Harness binaries (*.exe;*.cmd;*.bat;*.js)|*.exe;*.cmd;*.bat;*.js|All files (*.*)|*.*"

function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function defaultInitialDirectory(): string {
  const appData = process.env.APPDATA
  const npm = appData ? path.join(appData, "npm") : ""
  if (npm && existsSync(npm)) return npm
  return homedir()
}

/**
 * Opens a native Windows file dialog and returns the picked path, or `null`
 * if the user cancelled. Other platforms throw — the picker is Windows-only.
 *
 * WinForms has to run on an STA thread; `-STA` is a powershell.exe startup
 * flag, and `-EncodedCommand` keeps the script out of the argv quoting mess.
 */
export async function pickWindowsFile(options: {
  title: string
  initialDirectory?: string
}): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new Error("The harness file picker is only available on Windows.")
  }

  const initial =
    options.initialDirectory && existsSync(options.initialDirectory)
      ? options.initialDirectory
      : defaultInitialDirectory()

  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = ${psQuote(options.title)}
$dialog.Filter = ${psQuote(FILTER)}
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.InitialDirectory = ${psQuote(initial)}
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$result = $dialog.ShowDialog($form)
$form.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}
`.trim()

  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-STA", "-EncodedCommand", encodeCommand(script)],
    {
      windowsHide: false,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }
  )
  const picked = stdout.replace(/^\uFEFF/, "").trim()
  return picked || null
}
