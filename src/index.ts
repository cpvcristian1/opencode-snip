// Port to the OpenCode V2 plugin API. OpenCode V2 rejects V1 hook objects
// ("Plugin must export a default definition with an id and a setup function"),
// so this version registers the equivalent V2 hooks instead:
//
//   V1 tool.execute.before (bash) -> V2 ctx.shell.hook("create.before")
//                                    + V2 ctx.tool.hook("execute.before") fallback
//
// Delegates to `snip hook` (Claude Code PreToolUse format) so the rewrite rules
// stay in snip: only filtered commands are wrapped, pipes/redirects/heredocs and
// command substitutions are left raw. Any failure leaves the command untouched.
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"

const DIR = path.dirname(fileURLToPath(import.meta.url))

// Prefer a snip binary shipped next to the plugin (no PATH dependency),
// then one at the package root, then plain `snip` from PATH.
function snipBin(): string {
  if (existsSync(path.join(DIR, "snip.exe"))) return path.join(DIR, "snip.exe")
  if (existsSync(path.join(DIR, "..", "snip.exe"))) return path.join(DIR, "..", "snip.exe")
  return "snip"
}

export function rewrite(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(snipBin(), ["hook"], { timeout: 2000 }, (error, stdout) => {
      if (error || !stdout.trim()) return resolve(undefined)
      try {
        const rewritten = JSON.parse(stdout).hookSpecificOutput?.updatedInput?.command
        resolve(typeof rewritten === "string" ? rewritten : undefined)
      } catch {
        resolve(undefined)
      }
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }))
  })
}

// snip's quoting (`"snip.exe" run -- cmd`) is valid in POSIX shells; in
// PowerShell a quoted string needs `&` to be invoked. When the shell is
// PowerShell, prefix every wrapped segment with `&`.
function psPrefix(command: string, isPS: boolean): string {
  if (!isPS) return command
  return command.replace(/("[^"]*"\s+)run\b/g, "& $1run")
}

function shellIsPS(shellName: unknown): boolean {
  return typeof shellName === "string" && /powershell|pwsh/i.test(shellName)
}

export const SnipPlugin = {
  id: "opencode-snip",
  async setup(ctx: any) {
    // Same probe as V1: without a working `snip hook`, do nothing.
    if (!(await rewrite("git status"))) {
      console.warn("[snip] snip hook unavailable (missing or old binary) — plugin disabled")
      return {}
    }

    // V2 shell hook: rewrite the command before execution.
    await ctx.shell.hook("create.before", async (event: any) => {
      try {
        if (!event.command || typeof event.command !== "string") return
        const isPS =
          shellIsPS(event.shell) || (event.shell == null && process.platform === "win32")
        const rewritten = await rewrite(event.command)
        if (rewritten) event.command = psPrefix(rewritten, isPS)
      } catch {
        /* fail-open */
      }
    })

    // Fallback in case an execution goes through the tool without the shell hook.
    await ctx.tool.hook("execute.before", async (event: any) => {
      try {
        if (event.tool !== "shell" && event.tool !== "bash") return
        const args = event.input
        if (!args || typeof args !== "object" || typeof args.command !== "string" || !args.command)
          return
        // ponytail: on win32 PowerShell is assumed (OpenCode's default); with
        // bash configured on Windows, drop the `&` prefixing
        const rewritten = await rewrite(args.command)
        if (rewritten) {
          args.command = psPrefix(rewritten, process.platform === "win32")
          event.input = args
        }
      } catch {
        /* fail-open */
      }
    })

    return {}
  },
}

export default SnipPlugin
