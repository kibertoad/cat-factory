/**
 * Detection half of the workspace-bin-in-a-script guard. The CLI that runs it in CI is
 * `check-workspace-bin-scripts.mjs`; its fixtures are `workspace-bin-scripts.test.mjs`.
 *
 * WHY THIS EXISTS. A workspace package that ships a CLI declares its `bin` at a BUILD OUTPUT
 * (`./dist/bin.js`), which is the only thing it can point at: that is the path the published
 * tarball carries. On a fresh checkout the file does not exist, so `pnpm install` cannot create
 * the `node_modules/.bin/<name>` shim and says so once per consumer:
 *
 *     [WARN] Failed to create bin at .../deploy/local/node_modules/.bin/cat-factory.
 *     ENOENT: no such file or directory, open '.../backend/packages/cli/dist/bin.js'
 *
 * The trap is what happens next: NOTHING re-links bins after a build. A `pre<task>` that builds
 * the package does not rescue the name, and neither does a repeat `pnpm install` (it sees the
 * tree as up to date and skips linking). The shim stays absent until an install that actually
 * re-links, so a script calling that bin BY NAME fails with `<name>: not found` on exactly the
 * fresh clone the setup instructions describe, while every CI lane, whose node_modules cache was
 * populated after a build, keeps passing. That combination is why prose alone could not hold the
 * rule: the failure is invisible to the people who would notice it.
 *
 * THE RULE HAS TWO HALVES, and only both together survive a refactor:
 *
 *   1. Inside this workspace, never spawn such a CLI by its bin name (`findWorkspaceBinCalls`).
 *   2. Spawn it as `node <relative>/dist/bin.js`, at the path the owning package DECLARES as that
 *      bin (`findBinPathDrift`). The by-path form trades a shim for a hardcoded string, and a
 *      string nothing checks is the next silent break: moving the CLI's `outDir` updates its own
 *      manifest, leaves the consumer's `predev` green, and fails at `pnpm dev` with
 *      `Cannot find module`. Tying the path to the declaration makes that move a build failure.
 *
 * WHAT IS NOT FLAGGED. A workspace bin pointing at a TRACKED file (`cat-smoke` and `cat-bench`
 * both point at `./src/cli.ts`, which Node runs directly) links at install time like any other,
 * so calling it by name is fine. Tracked-ness is the test rather than mere existence on disk:
 * `dist/bin.js` exists on a machine that has built once, which would let the guard pass locally
 * and fail nobody until the next clone. External bins (vitest, tsc, wrangler, nuxt) are
 * unaffected for the same reason, their files ship in the package that installs them.
 *
 * SCOPE. Half 1 reads COMMAND POSITION only, which is where a bin name resolves through PATH: a
 * bin name appearing as an ARGUMENT is not a spawn (`--reporter cat-factory` is a string), and
 * neither is a `dlx`/`npx` invocation, which resolves from the registry rather than the shim.
 * Half 2 reads the PATH a segment spawns, whether that path stands as the command itself or as
 * the script argument of a `node` invocation.
 */

import { posix } from 'node:path'

/**
 * Tokens after which the next token is a command again. `--` is included because the wrapper
 * idiom this repo uses (`<supervisor> <flags> -- <the real command>`) puts a spawn right after
 * it; a workspace bin name standing there as a mere file argument is not a shape that occurs.
 */
const SEPARATORS = new Set(['&&', '||', '|', ';', '&', '--'])

/**
 * The shell operators of `SEPARATORS` that need not be surrounded by whitespace, as one
 * alternation so `build&&cat-factory env` tokenises exactly like the spaced form. Longest-first
 * (`||` before `|`, `&&` before `&`) because alternation is ordered, and the lookbehind keeps a
 * redirection's `>&` (`2>&1`) from reading as a background `&` that opens command position.
 */
const OPERATOR = /(\|\||&&|;|\||(?<!>)&)/

/**
 * Package managers whose own subcommand decides whether they spawn through the consumer's PATH.
 * `<launcher> exec <name>` resolves `<name>` through the same `node_modules/.bin` shim a bare
 * call would, so the shim has to exist for it too; every other subcommand does not.
 */
const LAUNCHERS = new Set(['pnpm', 'yarn', 'npm'])

/** The one launcher subcommand that puts its own argument in command position. */
const PASSTHROUGH_SUBCOMMAND = 'exec'

/**
 * Launcher subcommands that definitively close command position: what follows is a script name
 * (`run`) or a registry resolution (`dlx`/`npx`/`create`), where the tarball already carries
 * `dist/` and the bin name therefore works.
 */
const TERMINAL_SUBCOMMANDS = new Set(['run', 'run-script', 'dlx', 'npx', 'create'])

/** `VAR=value` prefixes precede the command rather than being it. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** npm's rule for the string form of `bin`: the package's own name, unscoped. */
const unscoped = (name) => name.replace(/^@[^/]+\//, '')

/** A package-relative `bin` target as a repo-relative path. `dir` is '' for the root manifest. */
const repoPath = (dir, target) => posix.normalize([dir, target].filter(Boolean).join('/'))

/** The `[binName, target]` pairs of a manifest, in either of npm's two shapes for `bin`. */
const binEntries = ({ name, bin }) =>
  typeof bin === 'string' ? [[unscoped(name), bin]] : Object.entries(bin ?? {})

/**
 * Workspace bin names whose target is NOT a tracked file, so `pnpm install` cannot link them on
 * a fresh checkout.
 *
 * @param {Array<{name: string, dir: string, bin?: string | Record<string, string>}>} manifests
 *   `dir` is the package directory, POSIX-separated and relative to the repo root ('' for root).
 * @param {(path: string) => boolean} isTracked
 * @returns {Map<string, string>} bin name -> declaring package name
 */
export function collectUnlinkableBins(manifests, isTracked) {
  const bins = new Map()
  for (const manifest of manifests) {
    if (!manifest.bin) continue
    for (const [binName, target] of binEntries(manifest)) {
      if (!isTracked(repoPath(manifest.dir, target))) bins.set(binName, manifest.name)
    }
  }
  return bins
}

/**
 * Where each bin-declaring package says its binaries live, so a by-path spawn can be checked
 * against the declaration rather than against a copy of it.
 *
 * @param {Array<{name: string, dir: string, bin?: string | Record<string, string>}>} manifests
 * @returns {Map<string, {name: string, targets: Set<string>}>} package dir -> declared targets,
 *   each a repo-relative path.
 */
export function collectBinTargets(manifests) {
  const byDir = new Map()
  for (const manifest of manifests) {
    if (!manifest.bin) continue
    const targets = new Set(binEntries(manifest).map(([, t]) => repoPath(manifest.dir, t)))
    byDir.set(manifest.dir, { name: manifest.name, targets })
  }
  return byDir
}

/**
 * The whitespace- and operator-delimited tokens of a script.
 *
 * Splitting on the operators as well as on whitespace is what keeps an UNSPACED `a&&b` from
 * hiding a spawn behind the first token. Beyond that the tokenisation is deliberately shallow:
 * a script that needs quoting around the COMMAND is already outside what this guard can reason
 * about, and a quoted ARGUMENT can never be mistaken for a command because only the first token
 * of a segment is ever considered.
 */
function tokenize(script) {
  return script
    .replace(/[\r\n]+/g, ' ; ')
    .split(OPERATOR)
    .flatMap((part) => part.split(/\s+/))
    .filter(Boolean)
}

/**
 * The index of the token a launcher puts in command position, or -1 if it spawns nothing that
 * resolves through the shim.
 *
 * The scan looks for the `exec` KEYWORD rather than trying to identify the subcommand by
 * position, which is what lets it see through the launcher's own options without having to know
 * which of them take a value: `pnpm --filter <pkg> exec …`, `pnpm -r exec …` and
 * `pnpm exec --silent …` all reach the same conclusion as the bare two-token form. A subcommand
 * that closes command position stops the scan, so a script named `exec` cannot be misread as one.
 */
function passthroughIndex(tokens, launcherIndex) {
  for (let index = launcherIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (SEPARATORS.has(token)) return -1
    if (token.startsWith('-')) continue
    if (TERMINAL_SUBCOMMANDS.has(token)) return -1
    if (token !== PASSTHROUGH_SUBCOMMAND) continue
    // Past `exec`, skip its own options; the first bare token after them is the spawn.
    for (let target = index + 1; target < tokens.length; target += 1) {
      if (SEPARATORS.has(tokens[target])) return -1
      if (!tokens[target].startsWith('-')) return target
    }
    return -1
  }
  return -1
}

/**
 * The commands a script spawns, each with the arguments that follow it up to the next separator.
 *
 * @param {string} script
 * @returns {Array<{command: string, args: string[]}>}
 */
export function commandSegments(script) {
  const tokens = tokenize(script)
  const segments = []
  let expectCommand = true
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (SEPARATORS.has(token)) {
      expectCommand = true
      continue
    }
    if (!expectCommand) continue
    if (ASSIGNMENT.test(token)) continue
    if (LAUNCHERS.has(token)) {
      const target = passthroughIndex(tokens, index)
      // Resume ON the spawned token with command position still open, so a nested launcher
      // (`pnpm exec pnpm exec …`) unwinds through the same branch.
      if (target !== -1) {
        index = target - 1
        continue
      }
    }
    const args = []
    for (let arg = index + 1; arg < tokens.length && !SEPARATORS.has(tokens[arg]); arg += 1) {
      args.push(tokens[arg])
    }
    segments.push({ command: token, args })
    expectCommand = false
  }
  return segments
}

/**
 * The tokens of `script` that sit in command position.
 *
 * @param {string} script
 * @returns {string[]}
 */
export function commandTokens(script) {
  return commandSegments(script).map((segment) => segment.command)
}

/**
 * Scripts across the workspace that spawn an unlinkable workspace bin by name.
 *
 * @param {Array<{path: string, scripts?: Record<string, string>}>} manifests
 * @param {Map<string, string>} unlinkableBins
 * @returns {Array<{path: string, script: string, command: string, bin: string, owner: string}>}
 */
export function findWorkspaceBinCalls(manifests, unlinkableBins) {
  const findings = []
  for (const { path, scripts } of manifests) {
    for (const [script, command] of Object.entries(scripts ?? {})) {
      for (const token of commandTokens(command)) {
        const owner = unlinkableBins.get(token)
        if (owner) findings.push({ path, script, command, bin: token, owner })
      }
    }
  }
  return findings
}

/** The bin-declaring package a repo-relative path falls inside, by longest matching directory. */
function ownerOf(path, binTargets) {
  let owner
  for (const [dir, entry] of binTargets) {
    if (dir !== '' && !path.startsWith(`${dir}/`)) continue
    if (!owner || dir.length > owner.dir.length) owner = { dir, ...entry }
  }
  return owner
}

/**
 * The file a segment spawns by path, or undefined if it names no path.
 *
 * Two shapes reach a build output: `node <path>` (what the by-name fix looks like) and the path
 * standing alone as the command, which is how an executable entry point is called. Both are
 * checked, because they are interchangeable at the call site and only one of them being watched
 * would make the guard a matter of spelling.
 */
function spawnedPath({ command, args }) {
  if (command.includes('/')) return command
  if (command !== 'node') return undefined
  return args.find((arg) => !arg.startsWith('-'))
}

/**
 * Scripts that spawn ANOTHER workspace package's build output by path at somewhere other than
 * one of that package's declared `bin` targets.
 *
 * Scoped to UNTRACKED targets: a tracked source file (`node ../x/src/cli.ts`) carries none of
 * this fragility, and a path into a package that declares no bin has no declaration to be
 * checked against.
 *
 * @param {Array<{path: string, dir: string, scripts?: Record<string, string>}>} manifests
 * @param {Map<string, {name: string, targets: Set<string>}>} binTargets
 * @param {(path: string) => boolean} isTracked
 * @returns {Array<{path: string, script: string, command: string, spawned: string, owner: string,
 *   targets: string[]}>}
 */
export function findBinPathDrift(manifests, binTargets, isTracked) {
  const findings = []
  for (const { path, dir, scripts } of manifests) {
    for (const [script, command] of Object.entries(scripts ?? {})) {
      for (const segment of commandSegments(command)) {
        const spawnedArg = spawnedPath(segment)
        if (!spawnedArg) continue
        const spawned = repoPath(dir, spawnedArg)
        if (isTracked(spawned)) continue
        const owner = ownerOf(spawned, binTargets)
        if (!owner || owner.dir === dir || owner.targets.has(spawned)) continue
        findings.push({
          path,
          script,
          command,
          spawned,
          owner: owner.name,
          targets: [...owner.targets],
        })
      }
    }
  }
  return findings
}
