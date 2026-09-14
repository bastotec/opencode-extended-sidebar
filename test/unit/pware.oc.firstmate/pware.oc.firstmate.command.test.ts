import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  discoverFirstmate,
  firstmateCommandEnv,
  trustedFirstmatePath,
} from "../../../src/pware.oc.firstmate/pware.oc.firstmate.discovery.js"
import { createDirectChildTerminator, runFirstmateCommand } from "../../../src/pware.oc.firstmate/pware.oc.firstmate.command.js"

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function homeWithScript(script: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oes-firstmate-"))
  cleanup.push(home)
  fs.mkdirSync(path.join(home, "bin"))
  const executable = path.join(home, "bin", "fm-fleet-snapshot.sh")
  fs.writeFileSync(executable, `#!/bin/sh\n${script}\n`, { mode: 0o700 })
  return home
}

describe("Firstmate discovery and command", () => {
  test("uses explicit priority, canonical paths, and rejects filesystem root", () => {
    const preferred = homeWithScript("printf '{}'")
    const fallback = homeWithScript("printf '{}'")
    const selected = discoverFirstmate({ OES_FIRSTMATE_HOME: preferred, FM_HOME: fallback })
    expect(selected.configured && selected.home).toBe(fs.realpathSync(preferred))
    const rejected = discoverFirstmate({ OES_FIRSTMATE_HOME: preferred, OES_FIRSTMATE_ROOT: "/" })
    expect(rejected.configured && rejected.diagnostic).toContain("filesystem root")
    const separateRoot = homeWithScript("printf '{}'")
    const rejectedHome = discoverFirstmate({ OES_FIRSTMATE_HOME: "/", OES_FIRSTMATE_ROOT: separateRoot })
    expect(rejectedHome.configured && rejectedHome.diagnostic).toContain("home cannot be")
  })

  test("rejects replaceable code paths and wrong ownership", () => {
    const home = homeWithScript("printf '{}'")
    const bin = path.join(home, "bin")
    const executable = path.join(bin, "fm-fleet-snapshot.sh")
    fs.chmodSync(bin, 0o777)
    const replaceableBin = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    expect(replaceableBin.configured && replaceableBin.diagnostic).toContain("group or world writable")
    fs.chmodSync(bin, 0o755)
    fs.chmodSync(executable, 0o777)
    const replaceableExecutable = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    expect(replaceableExecutable.configured && replaceableExecutable.diagnostic).toContain("group or world writable")
    fs.chmodSync(executable, 0o700)
    const codeRoot = homeWithScript("printf '{}'")
    fs.chmodSync(codeRoot, 0o777)
    const replaceableRoot = discoverFirstmate({ OES_FIRSTMATE_HOME: home, OES_FIRSTMATE_ROOT: codeRoot })
    expect(replaceableRoot.configured && replaceableRoot.diagnostic).toContain("root is group or world writable")
    const uid = fs.statSync(home).uid
    expect(trustedFirstmatePath(home, { expectedUid: uid + 1 })).toContain("not owned")
  })

  test("rejects operational home paths that escape through symlinks", () => {
    const home = homeWithScript("printf '{}'")
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "oes-firstmate-outside-"))
    cleanup.push(outside)
    fs.symlinkSync(outside, path.join(home, "state"))
    const config = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    expect(config.configured && config.diagnostic).toContain("escapes its operational home")
  })

  test("rejects an operational symlink to the immediate parent", () => {
    const home = homeWithScript("printf '{}'")
    fs.symlinkSync(path.dirname(home), path.join(home, "state"))
    const config = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    expect(config.configured && config.diagnostic).toContain("escapes its operational home")
  })

  test("reports explicit invalid configuration without throwing", () => {
    const config = discoverFirstmate({ OES_FIRSTMATE_HOME: "/definitely/not/a/firstmate/home" })
    expect(config.configured).toBe(true)
    expect(config.configured && config.diagnostic).not.toBeNull()
  })

  test("sanitizes command environment and invokes only the fixed json argv", async () => {
    const home = homeWithScript("printf '%s|%s|%s|%s' \"$1\" \"$FM_HOME\" \"${FM_FAKE:-unset}\" \"${BASH_ENV:-unset}\"")
    const config = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    if (!config.configured || config.diagnostic) throw new Error("expected valid config")
    const env = firstmateCommandEnv(config, {
      PATH: "/test/path",
      HOME: "/tmp/bad-home",
      XDG_CONFIG_HOME: "/tmp/bad-xdg",
      GIT_CONFIG_GLOBAL: "/tmp/bad-gitconfig",
      LD_PRELOAD: "/tmp/bad-loader",
      DYLD_INSERT_LIBRARIES: "/tmp/bad-loader",
      NODE_OPTIONS: "--require=/tmp/bad-tool",
      FM_FAKE: "bad",
      BASH_ENV: "/tmp/bad",
    })
    expect(env.PATH).toBe("/test/path")
    expect(env.HOME).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(env.LD_PRELOAD).toBeUndefined()
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.FM_FAKE).toBeUndefined()
    expect(env.BASH_ENV).toBeUndefined()
    expect(env.FM_SNAPSHOT_CACHE_DIR).toBe("/dev/null/firstmate-cache-disabled")
    expect(env.FM_STATE_OVERRIDE).toBe(path.join(fs.realpathSync(home), "state"))
    expect(env.FM_DATA_OVERRIDE).toBe(path.join(fs.realpathSync(home), "data"))
    const result = await runFirstmateCommand(config, { env: { PATH: process.env.PATH, FM_FAKE: "bad", BASH_ENV: "/tmp/bad" } })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe(`--json|${fs.realpathSync(home)}|unset|unset`)
  })

  test("enforces the whole-process deadline", async () => {
    const home = homeWithScript("sleep 2")
    const config = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    if (!config.configured || config.diagnostic) throw new Error("expected valid config")
    const started = performance.now()
    const result = await runFirstmateCommand(config, { deadlineMs: 10 })
    const elapsed = performance.now() - started
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("timeout")
    expect(elapsed).toBeLessThan(1_500)
  })

  test("does not spawn for a pre-aborted request", async () => {
    const marker = path.join(os.tmpdir(), `oes-firstmate-pre-abort-${process.pid}-${Date.now()}`)
    cleanup.push(marker)
    const home = homeWithScript(`: > "${marker}"`)
    const config = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    if (!config.configured || config.diagnostic) throw new Error("expected valid config")
    const controller = new AbortController()
    controller.abort()
    const result = await runFirstmateCommand(config, { signal: controller.signal })
    expect(result.reason).toBe("cancelled")
    expect(fs.existsSync(marker)).toBe(false)
  })

  test("bounds inherited pipe waits without signaling descendants after leader exit", async () => {
    const home = homeWithScript("(sleep 0.3) & exit 0")
    const config = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    if (!config.configured || config.diagnostic) throw new Error("expected valid config")
    const started = performance.now()
    const result = await runFirstmateCommand(config, { deadlineMs: 100 })
    const elapsed = performance.now() - started
    expect(result.reason).toBe("timeout")
    expect(elapsed).toBeLessThan(1_000)
  })

  test("direct-child termination is idempotent and sends no signal after observed exit", async () => {
    const signals: NodeJS.Signals[] = []
    const child = { exitCode: null, kill: (signal: NodeJS.Signals) => { signals.push(signal) } }
    const terminate = createDirectChildTerminator(child, Promise.resolve(), () => true, 1)
    await Promise.all([terminate(), terminate()])
    expect(signals).toEqual([])
  })

  test("direct-child termination escalates only while the child remains active", async () => {
    const signals: NodeJS.Signals[] = []
    let observed = false
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => { resolveExit = resolve })
    const child = {
      exitCode: null as number | null,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal)
        if (signal === "SIGTERM") {
          child.exitCode = 0
          observed = true
          resolveExit()
        }
      },
    }
    const terminate = createDirectChildTerminator(child, exited, () => observed, 1)
    await terminate()
    expect(signals).toEqual(["SIGTERM"])
  })

  test("direct-child termination escalates to kill when no exit is observed", async () => {
    const signals: NodeJS.Signals[] = []
    const child = { exitCode: null, kill: (signal: NodeJS.Signals) => { signals.push(signal) } }
    const terminate = createDirectChildTerminator(child, new Promise(() => {}), () => false, 1)
    await terminate()
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("terminates output beyond the process result bound", async () => {
    const home = homeWithScript("dd if=/dev/zero bs=1048576 count=5 2>/dev/null")
    const config = discoverFirstmate({ OES_FIRSTMATE_HOME: home })
    if (!config.configured || config.diagnostic) throw new Error("expected valid config")
    const result = await runFirstmateCommand(config)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("oversized")
    expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024)
  })
})
