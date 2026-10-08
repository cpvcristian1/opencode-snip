import { describe, it, expect, beforeEach, vi } from "vitest"
import { SnipPlugin, rewrite } from "./index"

// Same probe as the plugin startup: an old snip without `hook` skips these tests.
const hasSnipHook = (await rewrite("git status")) !== undefined

const SNIP_RUN = /^"[^"]*snip(\.exe)?" run -- /

// Captures the V2 hooks the plugin registers at setup.
async function setupPlugin() {
  const hooks: Record<string, (event: any) => Promise<void>> = {}
  const ctx = {
    shell: {
      hook: async (name: string, cb: (event: any) => Promise<void>) => {
        hooks[`shell.${name}`] = cb
      },
    },
    tool: {
      hook: async (name: string, cb: (event: any) => Promise<void>) => {
        hooks[`tool.${name}`] = cb
      },
    },
  }
  const result = await SnipPlugin.setup(ctx)
  return { hooks, result }
}

describe("SnipPlugin (V2)", () => {
  describe("when snip is not reachable", () => {
    it("should register no hooks and disable the plugin", async () => {
      const origPath = process.env.PATH
      process.env.PATH = ""
      vi.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const { hooks, result } = await setupPlugin()
        expect(result).toEqual({})
        expect(Object.keys(hooks)).toHaveLength(0)
      } finally {
        process.env.PATH = origPath
        vi.restoreAllMocks()
      }
    })
  })

  describe.skipIf(!hasSnipHook)("with snip", () => {
    let hooks: Record<string, (event: any) => Promise<void>>

    beforeEach(async () => {
      hooks = (await setupPlugin()).hooks
    })

    async function runTool(tool: string, command: string) {
      const event = { tool, input: { command } }
      await hooks["tool.execute.before"](event)
      return event.input.command
    }

    async function runShell(command: string) {
      const event = { command }
      await hooks["shell.create.before"](event)
      return event.command
    }

    it("should not modify non-shell tool calls", async () => {
      expect(await runTool("read", "git status")).toBe("git status")
    })

    it("should wrap a command snip has a filter for", async () => {
      const command = await runTool("bash", "git status")
      expect(command).toMatch(SNIP_RUN)
      expect(command).toMatch(/ run -- git status$/)
    })

    it("should wrap through the shell hook too", async () => {
      expect(await runShell("git status")).toMatch(/ run -- git status$/)
    })

    it("should keep env var prefixes before snip", async () => {
      expect(await runTool("bash", "CGO_ENABLED=0 go test ./...")).toMatch(
        /^CGO_ENABLED=0 "[^"]*" run -- go test \.\/\.\.\.$/,
      )
    })

    it("should wrap each segment of a compound command", async () => {
      expect(await runTool("bash", "git status && git log -5")).toMatch(
        / run -- git status && "[^"]*" run -- git log -5$/,
      )
    })

    it("should not double wrap an already wrapped command", async () => {
      const wrapped = await runTool("bash", "git status")
      expect(await runTool("bash", wrapped)).toBe(wrapped)
    })

    it.each([
      ["shell builtin", "cd /tmp"],
      ["command without filter", "echo hello"],
      ["head feeding a pipe", "git log | head"],
      ["head feeding a redirect", "go test ./... > out.txt"],
      ["command substitution", "git log $(git rev-parse HEAD)"],
      ["heredoc", "cat <<EOF\ngit status\nEOF"],
    ])("should leave %s untouched", async (_, command) => {
      expect(await runTool("bash", command)).toBe(command)
    })
  })
})
