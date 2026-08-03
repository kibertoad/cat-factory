import { describe, expect, it } from 'vitest'
// Raw source imports rather than `node:fs`: these tests run inside workerd, which has no
// filesystem. Vite inlines the text at build time, so the assertion still reads the real file.
import appSource from '../src/app.ts?raw'
import containerSource from '../src/infrastructure/container.ts?raw'
import assemblySource from '../src/infrastructure/container-assembly.ts?raw'
import executorSource from '../src/infrastructure/container-executor-deps.ts?raw'

// The Worker twin of `runtimes/node/test/tool-secret-seam.coverage.spec.ts` — see that file for
// why the guard is structural. The chain differs here in one way that matters: the factory is
// called on EVERY per-request container build rather than once at composition, because a Worker
// has no ambient environment and a deployment's own resolver reaches its store through a BINDING
// on `env`.

const SOURCES: Record<string, [string, RegExp[]]> = {
  // The option a deployment sets on `createWorker`.
  'src/app.ts': [
    appSource,
    [
      /createToolSecretResolver\?: \(env: Env\) => ToolSecretResolver/,
      /createToolSecretResolver: options\.createToolSecretResolver/,
    ],
  ],
  // The per-request build calling it with THIS request's env.
  'src/infrastructure/container.ts': [
    containerSource,
    [/opts\.createToolSecretResolver\?\.\(env\)/],
  ],
  // …carried across the assembly boundary…
  'src/infrastructure/container-assembly.ts': [
    assemblySource,
    [/resolveToolSecrets: executorToolSecrets/],
  ],
  // …and preferred over the env-backed default by the executor.
  'src/infrastructure/container-executor-deps.ts': [
    executorSource,
    [/deps\.resolveToolSecrets \?\?/],
  ],
}

describe('the tool-secret resolver seam reaches the container executor', () => {
  it('is threaded through every link of the Worker facade', () => {
    const missing: string[] = []
    for (const [file, [source, patterns]] of Object.entries(SOURCES)) {
      for (const pattern of patterns) {
        if (!pattern.test(source)) missing.push(`${file}: ${pattern}`)
      }
    }
    expect(missing).toEqual([])
  })
})
