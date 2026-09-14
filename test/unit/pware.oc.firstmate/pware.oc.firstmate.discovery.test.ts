import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { discoverFirstmate, firstmateCommandEnv, trustedFirstmatePath } from "../../../src/pware.oc.firstmate/pware.oc.firstmate.discovery.js"

describe("Firstmate safety boundaries", () => {
  test("requires ownership by the selected current uid even when the path is root-owned", () => {
    const target = fs.statSync("/").uid === 0 ? "/" : fs.mkdtempSync(path.join(os.tmpdir(), "oes-firstmate-owner-"))
    try {
      const owner = fs.statSync(target).uid
      expect(trustedFirstmatePath(target, { expectedUid: owner + 1 })).toBe("is not owned by the current user")
    } finally {
      if (target !== "/") fs.rmSync(target, { recursive: true, force: true })
    }
  })

  test("builds a minimal command environment", () => {
    const config = { configured: true as const, home: "/firstmate/home", root: "/firstmate/root", executable: "/firstmate/root/bin/fm-fleet-snapshot.sh", diagnostic: null }
    const env = firstmateCommandEnv(config, {
      PATH: "/trusted/path",
      HOME: "/ambient/home",
      XDG_RUNTIME_DIR: "/ambient/runtime",
      GIT_CONFIG_SYSTEM: "/ambient/gitconfig",
      DYLD_LIBRARY_PATH: "/ambient/libraries",
      NODE_OPTIONS: "--require=ambient-tool",
      FM_FAKE: "ambient-firstmate-setting",
    })
    expect(Object.keys(env).sort()).toEqual([
      "FM_CONFIG_OVERRIDE",
      "FM_DATA_OVERRIDE",
      "FM_HOME",
      "FM_PROJECTS_OVERRIDE",
      "FM_ROOT_OVERRIDE",
      "FM_SNAPSHOT_CACHE_DIR",
      "FM_STATE_OVERRIDE",
      "PATH",
    ])
  })

  test("ignores an ambient Firstmate environment and only opts in through OES variables", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "oes-firstmate-ambient-"))
    try {
      fs.mkdirSync(path.join(home, "bin"), { recursive: true })
      fs.writeFileSync(path.join(home, "bin", "fm-fleet-snapshot.sh"), "#!/bin/sh\nprintf '{}'\n", { mode: 0o700 })
      expect(discoverFirstmate({ FM_HOME: home, FM_ROOT_OVERRIDE: home }).configured).toBe(false)
      expect(discoverFirstmate({ OES_FIRSTMATE_HOME: home })).toMatchObject({ configured: true, diagnostic: null })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test("rejects a resolved executable path through an unsafe intermediate directory", () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "oes-firstmate-chain-"))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "oes-firstmate-home-"))
    try {
      const unsafe = path.join(container, "unsafe")
      const root = path.join(unsafe, "root")
      fs.mkdirSync(path.join(root, "bin"), { recursive: true })
      fs.writeFileSync(path.join(root, "bin", "fm-fleet-snapshot.sh"), "#!/bin/sh\nprintf '{}'\n", { mode: 0o700 })
      fs.chmodSync(unsafe, 0o777)
      const rootLink = path.join(home, "root-link")
      fs.symlinkSync(root, rootLink)
      const config = discoverFirstmate({ OES_FIRSTMATE_HOME: home, OES_FIRSTMATE_ROOT: rootLink })
      expect(config.configured && config.diagnostic).toContain("replaceable group or world-writable ancestor")
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(container, { recursive: true, force: true })
    }
  })
})
