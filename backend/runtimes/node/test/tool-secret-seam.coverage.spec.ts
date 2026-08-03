import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The capability-credential resolver seam must stay THREADED from each facade's option bag to the
// container executor.
//
// This is a structural guard because the failure it catches is structural and silent. Every link
// in the chain is an OPTIONAL field, so a refactor that drops one still typechecks, still passes
// every behavioural test, and leaves the deployment quietly running the default chain while its
// option is accepted and ignored: the shape of "a documented lever nobody can pull", which is
// exactly the defect this seam was added to remove.
//
// Its Worker twin is `runtimes/cloudflare/test/tool-secret-seam.coverage.test.ts`, which pins a
// process-wide REGISTRATION instead, because a Worker builds a container per entry point and the
// one that dispatches container agents is the durable driver. Node composes a single container at
// boot, so an option threaded through `start()` genuinely reaches every dispatch, and threading is
// the whole claim here.
//
// The LOCAL facade rides the Node one, but through three links of its own (`startLocal`, the
// mothership boot, and the container it builds), so it is covered here rather than trusted: a
// mothership-mode node is the deployment shape with the most reason to replace the resolver, since
// its capability definitions are authored by the mothership and its environment is a laptop's.

// Matched on IDENTIFIERS rather than on whole expressions. What must not silently disappear is the
// link; a pattern spanning an operator or an argument list also fails when `oxfmt` rewraps the
// line, which is a red guard for no behavioural reason.
const SOURCES: Record<string, string[]> = {
  // The option a deployment sets.
  '../src/container-options.ts': ['createToolSecretResolver'],
  // `start()` forwarding it onto the options object it builds the container from.
  '../src/server.ts': ['createToolSecretResolver'],
  // The composition root calling the factory with this process's env and handing the result to
  // the executor.
  '../src/container-run-platform.ts': ['options.createToolSecretResolver'],
  // The executor preferring an injected resolver over the platform's own chain.
  '../src/container-executor-deps.ts': ['resolveToolSecrets ??'],
  // The local facade's own option, declared and forwarded on both of its boot paths.
  '../../local/src/server.ts': ['createToolSecretResolver'],
}

// `startLocal` has two boot paths and each builds its own container, so the option has to appear
// on both or a mothership-mode node silently loses it. Once as the declared option on each of the
// two option bags, then once per forward.
const LOCAL_MENTIONS = 4

describe('the tool-secret resolver seam reaches the container executor', () => {
  const read = (file: string) => readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

  it('is threaded through every link of the Node and local facades', async () => {
    const missing: string[] = []
    for (const [file, needles] of Object.entries(SOURCES)) {
      const source = await read(file)
      for (const needle of needles) {
        if (!source.includes(needle)) missing.push(`${file}: ${needle}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('threads it through BOTH of the local facade’s boot paths', async () => {
    const source = await read('../../local/src/server.ts')
    const mentions = source.match(/createToolSecretResolver/g) ?? []
    expect(mentions.length).toBeGreaterThanOrEqual(LOCAL_MENTIONS)
  })
})
