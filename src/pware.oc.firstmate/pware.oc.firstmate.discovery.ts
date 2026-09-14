import fs from "node:fs"
import path from "node:path"

export type FirstmateConfiguration =
  | { configured: false }
  | { configured: true; home: string; root: string; executable: string; diagnostic: string | null }

function explicit(env: NodeJS.ProcessEnv, name: string): string | null {
  return env[name]?.trim() || null
}

function canonical(input: string): string {
  const resolved = path.resolve(input)
  try { return fs.realpathSync(resolved) } catch { return resolved }
}

function within(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function trustedExecutableAncestors(target: string, expectedUid: number): string | null {
  const parsed = path.parse(target)
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  const ancestors = [current]
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    ancestors.push(current)
  }
  for (const ancestor of ancestors) {
    current = ancestor
    const stat = fs.statSync(current)
    if (!stat.isDirectory()) return `${current} is not a directory`
    if (stat.uid !== expectedUid && stat.uid !== 0) return `${current} is not owned by the current user or root`
    const writable = (stat.mode & 0o022) !== 0
    const sticky = (stat.mode & 0o1000) !== 0
    if (writable && !sticky) return `${current} is a replaceable group or world-writable ancestor`
  }
  return null
}

export function trustedFirstmatePath(
  target: string,
  options: { expectedUid?: number; executable?: boolean } = {},
): string | null {
  try {
    const stat = fs.statSync(target)
    if (options.executable) {
      if (!stat.isFile() || (stat.mode & 0o111) === 0) return "is not a regular executable"
    } else if (!stat.isDirectory()) return "is not a directory"
    const expectedUid = options.expectedUid ?? (typeof process.getuid === "function" ? process.getuid() : stat.uid)
    if (stat.uid !== expectedUid) return "is not owned by the current user"
    if ((stat.mode & 0o022) !== 0) return "is group or world writable"
    return null
  } catch {
    return "is unavailable"
  }
}

export function discoverFirstmate(env: NodeJS.ProcessEnv = process.env): FirstmateConfiguration {
  const selectedHome = explicit(env, "OES_FIRSTMATE_HOME")
  if (!selectedHome) return { configured: false }
  const home = canonical(selectedHome)
  const explicitRoot = explicit(env, "OES_FIRSTMATE_ROOT")
  const root = canonical(explicitRoot ?? home)
  const executablePath = path.join(root, "bin", "fm-fleet-snapshot.sh")
  const unavailable = (diagnostic: string): FirstmateConfiguration => ({
    configured: true,
    home,
    root,
    executable: executablePath,
    diagnostic,
  })

  if (home === path.parse(home).root) return unavailable("Firstmate home cannot be the filesystem root")
  if (root === path.parse(root).root) return unavailable("Firstmate root cannot be the filesystem root")
  const homeTrust = trustedFirstmatePath(home)
  if (homeTrust) return unavailable(`Firstmate home ${homeTrust}`)
  const rootTrust = trustedFirstmatePath(root)
  if (rootTrust) return unavailable(`Firstmate root ${rootTrust}`)
  const bin = canonical(path.join(root, "bin"))
  if (!within(root, bin)) return unavailable("Firstmate bin directory escapes its configured root")
  const binTrust = trustedFirstmatePath(bin)
  if (binTrust) return unavailable(`Firstmate bin directory ${binTrust}`)
  const executable = canonical(executablePath)
  if (!within(root, executable)) return unavailable("Firstmate snapshot executable escapes its configured root")
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : fs.statSync(executable).uid
  try {
    const ancestorTrust = trustedExecutableAncestors(executable, expectedUid)
    if (ancestorTrust) return unavailable(`Firstmate snapshot executable ancestor ${ancestorTrust}`)
  } catch {
    return unavailable("Firstmate snapshot executable ancestor is unavailable")
  }
  const executableTrust = trustedFirstmatePath(executable, { executable: true })
  if (executableTrust) return unavailable(`Firstmate snapshot executable ${executableTrust}`)

  for (const name of ["state", "data", "config", "projects"]) {
    const operational = path.join(home, name)
    if (!fs.existsSync(operational)) continue
    const resolved = canonical(operational)
    if (!within(home, resolved)) return unavailable(`Firstmate ${name} path escapes its operational home`)
  }
  return { configured: true, home, root, executable, diagnostic: null }
}

export function firstmateCommandEnv(
  config: Extract<FirstmateConfiguration, { configured: true }>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const clean: Record<string, string> = {}
  if (env.PATH) clean.PATH = env.PATH
  return {
    ...clean,
    FM_HOME: config.home,
    FM_ROOT_OVERRIDE: config.root,
    FM_STATE_OVERRIDE: path.join(config.home, "state"),
    FM_DATA_OVERRIDE: path.join(config.home, "data"),
    FM_CONFIG_OVERRIDE: path.join(config.home, "config"),
    FM_PROJECTS_OVERRIDE: path.join(config.home, "projects"),
    FM_SNAPSHOT_CACHE_DIR: "/dev/null/firstmate-cache-disabled",
  }
}
