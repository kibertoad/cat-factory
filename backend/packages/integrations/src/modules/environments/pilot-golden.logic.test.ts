import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CreateSharedStackInput,
  type StackRecipe,
  createSharedStackSchema,
  stackRecipeSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import type { ProvisioningRepoReader } from './provision-detect.logic.js'
import { detectKubernetesProvisioning, detectSharedStack } from './provision-detect.logic.js'

// ---------------------------------------------------------------------------
// PILOT GOLDEN DETECTION (stack-recipes-and-shared-stacks, slice 9)
//
// The initiative's acceptance pilot is a complex-monolith consumer + a sibling shared
// infra stack. This suite pins the deterministic detector's output against a SANITIZED
// snapshot of those two real repos (fixtures under `__fixtures__/pilot/`), read the same
// checkout-free way production does — over a `ProvisioningRepoReader`, here backed by the
// filesystem instead of the GitHub/GitLab contents API.
//
// The fixtures are a faithful, reduced-and-sanitized copy of the pilot repos' PROVISIONING
// surface (compose files, override family, external network, profiles, env template, seed
// dumps, repo CLI) — reduced to exactly the facts the detector reads, sanitized of every
// upstream-specific name. They reproduce the sanitized live detection BYTE-FOR-BYTE, so the
// committed goldens double as an upstream-drift alarm: `scripts/pilot-detect-golden.mjs`
// re-derives them from the live clones (or the fixtures) and diffs, and this test catches any
// detector regression against the frozen pilot shape. See `__fixtures__/pilot/README.md`.
// ---------------------------------------------------------------------------

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'pilot')

/** A `ProvisioningRepoReader` backed by a fixture directory on disk (missing path ⇒ null/[]). */
function fsReader(rootAbs: string): ProvisioningRepoReader {
  return {
    async getFile(path) {
      try {
        return { content: readFileSync(join(rootAbs, path), 'utf-8') }
      } catch {
        return null
      }
    },
    async listDirectory(path) {
      try {
        return readdirSync(join(rootAbs, path), { withFileTypes: true }).map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          path: (path ? `${path}/` : '') + e.name,
        }))
      } catch {
        return []
      }
    },
  }
}

function readJson<T = unknown>(relPath: string): T {
  return JSON.parse(readFileSync(join(PILOT, relPath), 'utf-8')) as T
}

/** True when the fixture snapshot contains a file at this repo-relative path. */
function fixtureHas(repoDir: string, repoRelPath: string): boolean {
  try {
    readFileSync(join(PILOT, repoDir, repoRelPath), 'utf-8')
    return true
  } catch {
    return false
  }
}

describe('pilot golden detection', () => {
  it('reproduces the consumer-main docker-compose recommendation (recipe + candidates)', async () => {
    const recommendation = await detectKubernetesProvisioning(
      fsReader(join(PILOT, 'consumer-main')),
      {
        prefer: 'docker-compose',
      },
    )
    expect(recommendation).toEqual(readJson('consumer-main.detect.golden.json'))
  })

  it('reproduces the shared-services shared-stack recommendation', async () => {
    const recommendation = await detectSharedStack(fsReader(join(PILOT, 'shared-services')), {
      repoName: 'acme-shared-services',
    })
    expect(recommendation).toEqual(readJson('shared-services.detect.golden.json'))
  })

  // Guard the detector's key inferences on the pilot shape explicitly (beyond the byte-golden),
  // so a regression names WHICH signal broke rather than just "the golden changed".
  it('infers the recipe-defining signals from the complex consumer repo', async () => {
    const rec = await detectKubernetesProvisioning(fsReader(join(PILOT, 'consumer-main')), {
      prefer: 'docker-compose',
    })
    expect(rec.provisioning.type).toBe('docker-compose')
    // Builds its images from source (acme-main-nginx has a `build:`) ⇒ build-from-source mode.
    expect(rec.provisioning.composeBuild).toBe(true)
    // Attaches to the shared stack's network ⇒ the shared-stack nudge.
    expect(rec.provisioning.recipe?.externalNetworks).toEqual(['acme-net'])
    // The two OS overrides are surfaced as opt-in candidates, never auto-layered.
    expect(
      rec.composeFileCandidates
        ?.filter((c) => c.os)
        .map((c) => c.os)
        .sort(),
    ).toEqual(['mac', 'wsl'])
    // Optional service groups surfaced default-off.
    expect(rec.profileCandidates?.map((p) => p.profile)).toEqual(['blackfire', 'datadog', 'otel'])
    // The fullest seed dump is pre-selected over the schema-only sibling.
    expect(rec.seedDumpCandidates?.find((s) => s.recommended)?.path).toBe(
      'deployment/acme-db-dummy/acme-dummy.sql',
    )
    // The repo's own imperative bring-up is flagged (the analyst nudge).
    expect(rec.repoCliHint).toEqual({ path: 'bin/dev-console', kind: 'repo-cli' })
  })

  it('the reference consumer recipe is a valid StackRecipe wired to the shared stack', () => {
    const recipe = v.parse(stackRecipeSchema, readJson('reference/consumer-recipe.json'))
    const stack = v.parse(createSharedStackSchema, readJson('reference/shared-stack.json'))

    // The consumer attaches to the SAME network the shared stack owns, and references it by name.
    expect(recipe.externalNetworks).toContain('acme-net')
    expect(stack.managedNetworks).toContain('acme-net')
    expect(recipe.sharedStackRefs).toEqual([stack.name])

    // The seed step imports a dump that actually exists in the consumer fixture (not a dangling ref).
    const seedStep = recipe.setupSteps?.find((s) => s.name === 'seed database')
    expect(seedStep?.kind).toBe('compose-exec')
    const stdinFile = seedStep?.kind === 'compose-exec' ? seedStep.stdinFile : undefined
    expect(stdinFile).toBeDefined()
    expect(fixtureHas('consumer-main', stdinFile!)).toBe(true)

    // The realized recipe covers the imperative A-rows of the mapping table.
    const stepNames = recipe.setupSteps?.map((s) => s.name) ?? []
    expect(stepNames).toEqual(
      expect.arrayContaining([
        'composer install',
        'seed database',
        'cache warmup',
        'database migrations',
        'create search indexes',
        'frontend build gate',
      ]),
    )
    expect(recipe.healthGate?.kind).toBe('compose-exec')
    // The M-rows are declared as preflights (docker daemon, RAM, registry login, mkcert, hosts, secrets).
    expect(recipe.prerequisites?.map((p) => p.check).sort()).toEqual([
      'docker-daemon',
      'env-secrets-marker',
      'hosts-entries',
      'memory',
      'mkcert-ca',
      'registry-auth',
    ])
  })

  it('the reference shared-stack config is a valid CreateSharedStackInput (public subset)', () => {
    const stack: CreateSharedStackInput = v.parse(
      createSharedStackSchema,
      readJson('reference/shared-stack.json'),
    )
    // The env template it materializes exists in the shared-services fixture.
    expect(stack.envFiles).toHaveLength(1)
    expect(fixtureHas('shared-services', stack.envFiles[0]!.template)).toBe(true)
    // The CI-validatable subset runs the PUBLIC `backends` profile only — no private-registry `peer`.
    expect(stack.composeProfiles).toEqual(['backends'])
    // The private-registry preflight is advisory (non-blocking) so the public subset still comes up.
    const registryPreflight = stack.prerequisites?.find((p) => p.check === 'registry-auth')
    expect(registryPreflight?.required).toBe(false)
    // host-command steps stay off by default (the one trust-boundary-widening step kind).
    expect(stack.allowHostCommands).toBe(false)
  })

  it('the shared-stack recommendation lines up with the consumer recipe (attach story)', async () => {
    const shared = await detectSharedStack(fsReader(join(PILOT, 'shared-services')), {
      repoName: 'acme-shared-services',
    })
    const recipe: StackRecipe = v.parse(
      stackRecipeSchema,
      readJson('reference/consumer-recipe.json'),
    )
    // Every external network the consumer expects is one the shared stack advertises as managed.
    for (const net of recipe.externalNetworks ?? []) {
      expect(shared.managedNetworks).toContain(net)
    }
  })
})
