import { describe, expect, it } from 'vitest'
// Raw source imports rather than `node:fs`: these tests run inside workerd, which has no
// filesystem. Vite inlines the text at build time, so the assertion still reads the real file.
import appSource from '../src/app.ts?raw'
import containerSource from '../src/infrastructure/container.ts?raw'
import assemblySource from '../src/infrastructure/container-assembly.ts?raw'
import executorSource from '../src/infrastructure/container-executor-deps.ts?raw'
import {
  clearToolSecretResolverFactory,
  registerToolSecretResolverFactory,
  resolveRegisteredToolSecretResolver,
} from '../src/infrastructure/toolSecretResolver'
import type { Env } from '../src/infrastructure/env'

// The Worker twin of `runtimes/node/test/tool-secret-seam.coverage.spec.ts`. The chain differs in
// the way that made this guard necessary: a Worker builds a container PER ENTRY POINT, and the
// entry point that dispatches container agents is the durable driver (`ExecutionWorkflow`), not
// the request path. So the seam is a PROCESS-WIDE registration read inside `buildContainer`, and
// what has to be pinned is that `buildContainer` reads the registration rather than an argument
// each of its many callers would have to remember to pass.
//
// The behavioural half is asserted directly (the registration round-trips and is what a container
// build would call); the structural half covers the links a typecheck cannot, since each is an
// optional field that a refactor could drop while still compiling and still passing every
// behavioural test.

describe('the tool-secret resolver registration', () => {
  it('round-trips a factory and builds it with the caller’s env', () => {
    const resolver = { resolve: async () => ({}) }
    const seen: Env[] = []
    registerToolSecretResolverFactory((env) => {
      seen.push(env)
      return resolver
    })
    const env = { ENVIRONMENT: 'test' } as unknown as Env
    expect(resolveRegisteredToolSecretResolver(env)).toBe(resolver)
    expect(seen).toEqual([env])
    clearToolSecretResolverFactory()
    expect(resolveRegisteredToolSecretResolver(env)).toBeUndefined()
  })

  it('lets the last registration win, since a container has exactly one resolver', () => {
    const first = { resolve: async () => ({}) }
    const second = { resolve: async () => ({}) }
    registerToolSecretResolverFactory(() => first)
    registerToolSecretResolverFactory(() => second)
    expect(resolveRegisteredToolSecretResolver({} as unknown as Env)).toBe(second)
    clearToolSecretResolverFactory()
  })
})

// Matched on IDENTIFIERS rather than on whole expressions: what must not silently disappear is
// the link, and a pattern spanning an operator or an argument list also fails when `oxfmt`
// rewraps the line, which is a red guard for no behavioural reason.
const SOURCES: Record<string, [string, string[]]> = {
  // The option a deployment sets on `createWorker`, registered process-wide rather than closed
  // over the app.
  'src/app.ts': [appSource, ['createToolSecretResolver', 'registerToolSecretResolverFactory']],
  // Every container build reads the registration. This is the assertion the guard exists for: it
  // holds for the durable driver, the queue consumers and the crons without naming them, because
  // they all come through this one function.
  'src/infrastructure/container.ts': [containerSource, ['resolveRegisteredToolSecretResolver']],
  // …carried across the assembly boundary…
  'src/infrastructure/container-assembly.ts': [assemblySource, ['executorToolSecrets']],
  // …and preferred by the executor over the platform's own resolver chain.
  'src/infrastructure/container-executor-deps.ts': [executorSource, ['deps.resolveToolSecrets']],
}

describe('the tool-secret resolver seam reaches the container executor', () => {
  it('is threaded through every link of the Worker facade', () => {
    const missing: string[] = []
    for (const [file, [source, needles]] of Object.entries(SOURCES)) {
      for (const needle of needles) {
        if (!source.includes(needle)) missing.push(`${file}: ${needle}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('leaves no container build able to bypass the registration', () => {
    // `buildContainer` must not ALSO take the resolver as an argument. It did once, and that is
    // precisely how the seam reached only the request path: the durable driver calls
    // `buildContainer(this.env)` with no options, so an argument is a link every future caller
    // has to remember and none of them fails to compile when it forgets.
    expect(containerSource).not.toContain('createToolSecretResolver')
  })
})
