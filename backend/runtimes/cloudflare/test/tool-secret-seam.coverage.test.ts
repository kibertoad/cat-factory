import { describe, expect, it } from 'vitest'
// Raw source imports rather than `node:fs`: these tests run inside workerd, which has no
// filesystem. Vite inlines the text at build time, so the assertion still reads the real file.
import appSource from '../src/app.ts?raw'
import containerSource from '../src/infrastructure/container.ts?raw'
import assemblySource from '../src/infrastructure/container-assembly.ts?raw'
import executorSource from '../src/infrastructure/container-executor-deps.ts?raw'
import {
  clearToolSecretPolicy,
  registerToolSecretPolicy,
  registeredToolSecretEnvironmentFallback,
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

describe('the tool-secret policy registration', () => {
  it('round-trips a factory and builds it with the caller’s env', () => {
    const resolver = { resolve: async () => ({}) }
    const seen: Env[] = []
    registerToolSecretPolicy({
      createResolver: (env) => {
        seen.push(env)
        return resolver
      },
    })
    const env = { ENVIRONMENT: 'test' } as unknown as Env
    expect(resolveRegisteredToolSecretResolver(env)).toBe(resolver)
    expect(seen).toEqual([env])
    clearToolSecretPolicy()
    expect(resolveRegisteredToolSecretResolver(env)).toBeUndefined()
  })

  it('lets the last registration win, since a container has exactly one chain', () => {
    const first = { resolve: async () => ({}) }
    const second = { resolve: async () => ({}) }
    registerToolSecretPolicy({ createResolver: () => first })
    registerToolSecretPolicy({ createResolver: () => second })
    expect(resolveRegisteredToolSecretResolver({} as unknown as Env)).toBe(second)
    clearToolSecretPolicy()
  })

  // The store-only declaration a multi-tenant deployment makes. Unregistered has to stay
  // UNDEFINED rather than defaulting here: the composition owns the default, and a `false`
  // invented at the read would turn every unregistered deployment store-only.
  it('carries the environment-fallback declaration, undefined until one is made', () => {
    expect(registeredToolSecretEnvironmentFallback()).toBeUndefined()
    registerToolSecretPolicy({ environmentFallback: false })
    expect(registeredToolSecretEnvironmentFallback()).toBe(false)
    clearToolSecretPolicy()
    expect(registeredToolSecretEnvironmentFallback()).toBeUndefined()
  })
})

// Matched on IDENTIFIERS rather than on whole expressions: what must not silently disappear is
// the link, and a pattern spanning an operator or an argument list also fails when `oxfmt`
// rewraps the line, which is a red guard for no behavioural reason.
const SOURCES: Record<string, [string, string[]]> = {
  // The option a deployment sets on `createWorker`, registered process-wide rather than closed
  // over the app.
  'src/app.ts': [
    appSource,
    [
      'createToolSecretResolver',
      'capabilityCredentialEnvironmentFallback',
      'registerToolSecretPolicy',
    ],
  ],
  // Every container build reads the registration. This is the assertion the guard exists for: it
  // holds for the durable driver, the queue consumers and the crons without naming them, because
  // they all come through this one function.
  'src/infrastructure/container.ts': [
    containerSource,
    ['resolveRegisteredToolSecretResolver', 'registeredToolSecretEnvironmentFallback'],
  ],
  // …carried across the assembly boundary: the RESOLVER to the executor, and the pair PROJECTED onto
  // the container through the one shared `toolSecretContainerFields`, so the credential checklist
  // describes the chain the dispatch path actually got and the tool-server probe resolves through
  // that same chain rather than some other tenant's credential…
  'src/infrastructure/container-assembly.ts': [
    assemblySource,
    ['toolSecretChain.resolver', 'toolSecretContainerFields'],
  ],
  // …and taken by the executor as a REQUIRED dependency. This link is the one the type system now
  // pins by itself: the field carried a bare Worker-vars default until it was made required, and
  // that default failed OPEN, so dropping the link here resolved every tenant off the deployment's
  // own configured vars rather than the per-workspace store. Pinned anyway, because what a guard
  // has to survive is someone restoring the convenience default.
  'src/infrastructure/container-executor-deps.ts': [
    executorSource,
    ['deps.resolveToolSecrets', 'resolveToolSecrets: ToolSecretResolver'],
  ],
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
