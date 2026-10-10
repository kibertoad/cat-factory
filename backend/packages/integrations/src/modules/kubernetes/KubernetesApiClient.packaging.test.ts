import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// `KubernetesApiClient` loads `undici` at RUNTIME, through a variable specifier so the Cloudflare
// Worker build cannot statically resolve it into the bundle. That specifier is invisible to every
// static tool the repo owns: knip cannot see the import, the typechecker cannot see it, and the
// mocked-`fetch` unit tests never reach it. Nothing, in other words, connects the code that needs
// the package to the manifest that has to declare it.
//
// The declaration is load-bearing rather than cosmetic. `deploy/node/Dockerfile` re-resolves with
// `pnpm install --prod`, which prunes devDependencies, and pnpm's isolated layout puts no package
// on the resolution path that did not ask for it. Declared as a devDependency, `undici` therefore
// resolves in every test lane and in no production image, so a custom-CA / skip-verify apiserver
// call would fail for a second time in a row on exactly the deployments (k3s, any self-signed
// apiserver) the dispatch fix exists to unblock.
//
// So this assertion is the only thing standing between a routine dependency sweep and that
// regression, which is what earns it a test of its own.

const manifest = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

describe('@cat-factory/integrations packaging', () => {
  it('declares undici as a runtime dependency, because the Kubernetes client imports it at runtime', () => {
    expect(manifest.dependencies ?? {}).toHaveProperty('undici')
  })

  it('does not also carry undici as a devDependency, which would mask a pruned production install', () => {
    expect(manifest.devDependencies ?? {}).not.toHaveProperty('undici')
  })
})
