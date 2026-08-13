import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROCESS_TITLE } from '../src/harness-server.js'

// The harness process must not be NAMEABLE by a pattern kill aimed at something else.
//
// It runs as PID 1 of the job container, as the same uid as the agent's shell, so every
// `pkill`/`pgrep`/`/proc` sweep the agent runs can reach it and a same-uid signal is permitted.
// That is not fixable by permissions here (dropping the agent to another uid would need a root
// PID 1, which the image deliberately does not have), so the defence is that nothing an agent
// searches for MATCHES this process. Two halves, both pinned below:
//
//   - the ENTRY FILE NAME, which is what `/proc/<pid>/cmdline` says until the process renames
//     itself, and what an operator reading `docker inspect` sees;
//   - the PROCESS TITLE, which replaces both `cmdline` and (truncated) `comm` once set.
//
// It was `dist/server.js`, which is also where an ordinary Node service builds to. A coder run
// that had just smoke-tested the service it wrote ran `pkill -f 'node dist/server.js'`, matched
// PID 1, and shut the harness down mid-job; the engine saw only a container that had vanished,
// called it an eviction, and re-dispatched into the same trap. The names below are the fix, so
// they are asserted rather than left to a comment.
//
// This is a `test/**`-only file, so it ships with NO runner-image bump.

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { main?: string; exports?: Record<string, unknown> }
const entrypoint = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/harness-server.ts', import.meta.url), 'utf8')

/**
 * Entry names an agent's own build output plausibly takes, and therefore the names its cleanup
 * searches for. Not a blocklist of bad ideas: it is the set this process must stay OUT of, and
 * every member of it has been the built entry of a service someone asked a coder to scaffold.
 */
const GENERIC_ENTRY_NAMES = ['server.js', 'index.js', 'app.js', 'main.js', 'server.mjs']

/** The `dist/…` path the container executes, read off the `exec` line of the entrypoint. */
function entrypointTarget(): string {
  const match = /^exec node (\S+)\s*$/m.exec(entrypoint)
  if (!match?.[1]) throw new Error('entrypoint.sh has no `exec node <entry>` line to read')
  return match[1]
}

describe('harness entry naming', () => {
  it('runs the one entry the package manifest declares', () => {
    // A drift guard first: three places name this file, and the container executes the one the
    // OTHER two do not check. `LOCAL_HARNESS_ENTRY`-less native mode resolves the package export,
    // so a rename that misses either half runs a different file in each mode.
    expect(packageJson.main).toBe('./dist/harness-server.js')
    expect(packageJson.exports?.['.']).toBe(packageJson.main)
    expect(`./${entrypointTarget()}`).toBe(packageJson.main)
  })

  it('does not take an entry name an agent would pattern-kill', () => {
    const entry = entrypointTarget().split('/').pop()
    expect(GENERIC_ENTRY_NAMES).not.toContain(entry)
  })

  it('renames the process to something no agent searches for', () => {
    expect(GENERIC_ENTRY_NAMES.map((name) => name.replace(/\.\w+$/, ''))).not.toContain(
      PROCESS_TITLE,
    )
    expect(PROCESS_TITLE).not.toContain('/')
    // `pkill node` matches on the (truncated) name, so the title has to differ within the 15
    // characters `/proc/<pid>/comm` keeps, so a title that only diverges later is no title.
    expect(PROCESS_TITLE.slice(0, 15)).not.toBe('node'.slice(0, 15))
    expect(PROCESS_TITLE.length).toBeGreaterThan(4)
  })

  it('assigns that title before it accepts a job', () => {
    // Exporting the constant is not the behaviour; assigning it is. Read as source because the
    // assignment is deliberately skipped under NODE_ENV=test (the suites import this module).
    const assignment = source.indexOf('process.title = PROCESS_TITLE')
    const listen = source.indexOf('server.listen(')
    expect(assignment).toBeGreaterThan(-1)
    expect(assignment).toBeLessThan(listen)
  })
})
