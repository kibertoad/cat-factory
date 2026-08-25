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
 * THE RULE. Inside this workspace, spawn such a CLI as `node <relative>/dist/bin.js`, never by
 * its bin name.
 *
 * WHAT IS NOT FLAGGED. A workspace bin pointing at a TRACKED file (`cat-smoke` and `cat-bench`
 * both point at `./src/cli.ts`, which Node runs directly) links at install time like any other,
 * so calling it by name is fine. Tracked-ness is the test rather than mere existence on disk:
 * `dist/bin.js` exists on a machine that has built once, which would let the guard pass locally
 * and fail nobody until the next clone. External bins (vitest, tsc, wrangler, nuxt) are
 * unaffected for the same reason, their files ship in the package that installs them.
 *
 * SCOPE. Command position only, which is where a bin name resolves through PATH. A bin name that
 * appears as an ARGUMENT is not flagged (`--reporter cat-factory` is a string, not a spawn), and
 * neither is a `dlx`/`npx` invocation, which resolves from the registry rather than the shim.
 */

/**
 * Tokens after which the next token is a command again. `--` is included because the wrapper
 * idiom this repo uses (`<supervisor> <flags> -- <the real command>`) puts a spawn right after
 * it; a workspace bin name standing there as a mere file argument is not a shape that occurs.
 */
const SEPARATORS = new Set(['&&', '||', '|', ';', '&', '--'])

/**
 * Wrappers whose NEXT token is itself the command being spawned through the same PATH, so the
 * shim has to exist for them too. `dlx`/`npx` are deliberately absent: those resolve from the
 * registry, where the tarball already carries `dist/`, so the name works there.
 */
const PASSTHROUGH = new Set(['pnpm exec', 'yarn exec', 'npm exec'])

/** `VAR=value` prefixes precede the command rather than being it. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** npm's rule for the string form of `bin`: the package's own name, unscoped. */
const unscoped = (name) => name.replace(/^@[^/]+\//, '')

/**
 * Workspace bin names whose target is NOT a tracked file, so `pnpm install` cannot link them on
 * a fresh checkout.
 *
 * @param {Array<{name: string, dir: string, bin?: string | Record<string, string>}>} manifests
 *   `dir` is the package directory, POSIX-separated and relative to the repo root ('' for root).
 * @param {(repoPath: string) => boolean} isTracked
 * @returns {Map<string, string>} bin name -> declaring package name
 */
export function collectUnlinkableBins(manifests, isTracked) {
  const bins = new Map()
  for (const { name, dir, bin } of manifests) {
    if (!bin) continue
    const entries = typeof bin === 'string' ? [[unscoped(name), bin]] : Object.entries(bin)
    for (const [binName, target] of entries) {
      const repoPath = [dir, target.replace(/^\.\//, '')].filter(Boolean).join('/')
      if (!isTracked(repoPath)) bins.set(binName, name)
    }
  }
  return bins
}

/**
 * The tokens of `script` that sit in command position.
 *
 * Tokenising on whitespace is enough because a package script that needs quoting around the
 * COMMAND is already outside what this guard can reason about, and a quoted argument can never
 * be mistaken for a command: only the first token of a segment is ever considered.
 *
 * @param {string} script
 * @returns {string[]}
 */
export function commandTokens(script) {
  const tokens = script.split(/\s+/).filter(Boolean)
  const commands = []
  let expectCommand = true
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (SEPARATORS.has(token)) {
      expectCommand = true
      continue
    }
    if (!expectCommand) continue
    if (ASSIGNMENT.test(token)) continue
    // A two-word wrapper consumes BOTH its tokens and leaves the next one in command position;
    // consuming only the first would blame the wrapper's own second word.
    if (PASSTHROUGH.has(`${token} ${tokens[index + 1] ?? ''}`)) {
      index += 1
      continue
    }
    commands.push(token)
    expectCommand = false
  }
  return commands
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
