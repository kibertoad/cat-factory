import { describe, expect, it } from 'vitest'
import {
  ASSET_STORAGE_CAPABILITY,
  PLATFORM_ASSET_STORAGE_SERVICE_ID,
  foundationalServiceDefinitionIssues,
  operationsAreIndexable,
} from '@cat-factory/contracts'
import { defaultFoundationalServiceRegistry } from './foundational-service-registry.js'
import {
  ASSET_UPLOAD_TOKEN_ENV,
  ASSET_UPLOAD_URL_ENV,
  platformAssetStorageService,
} from './platform-asset-service.js'

describe('the platform asset-storage service', () => {
  const definition = platformAssetStorageService()

  it('satisfies the very schema the REST write boundary applies to an uploaded one', () => {
    // A code-registered definition accepted where an uploaded one would be refused is exactly
    // the drift `foundationalServiceDefinitionIssues` exists to prevent, and this one boots on
    // every deployment, so a malformed field would fail them all rather than one.
    expect(foundationalServiceDefinitionIssues(definition)).toEqual([])
  })

  it('carries the capability tag admission requires of a storage target', () => {
    // Without it, `binaryOutputConfigIssues` refuses every step selecting it with
    // `not_storage_capable`: the shipped Media pipeline would be unrunnable out of the box.
    expect(definition.capabilities).toContain(ASSET_STORAGE_CAPABILITY)
  })

  it('names the environment variables the harness actually sets', () => {
    // The endpoint is per-run and per-transport, so it cannot be an OpenAPI `servers` entry: the
    // contract tells the agent where to read it from instead. A document naming a variable
    // nothing sets reads, through the brief's own wording, as a storage outage on a deployment
    // whose storage is fine. (The two spellings are pinned against the harness's own in
    // `artifact-upload.conformity.test.ts`.)
    const body = definition.contracts![0]!.body
    expect(body).toContain(ASSET_UPLOAD_URL_ENV)
    expect(body).toContain(ASSET_UPLOAD_TOKEN_ENV)
  })

  it('declares an OpenAPI contract whose operations the catalog can index', () => {
    // An unindexable format renders an EMPTY operation list, which reads to an agent as a service
    // that offers nothing, the one state `operationsAreIndexable` exists to keep apart.
    const contract = definition.contracts![0]!
    expect(operationsAreIndexable(contract.format)).toBe(true)
    expect(() => JSON.parse(contract.body)).not.toThrow()
  })

  it('is what the default registry ships, and the only thing it ships', () => {
    // The registry held nothing for as long as the tier existed, on the ground that no BUSINESS
    // capability is universal. This one is a capability of the platform itself, and adding a
    // second on that reasoning is the drift worth failing on.
    const entries = defaultFoundationalServiceRegistry().entries()
    expect(entries.map((entry) => entry.id)).toEqual([PLATFORM_ASSET_STORAGE_SERVICE_ID])
    expect(entries[0]!.contracts.map((contract) => contract.operations)).toEqual([
      ['DELETE /{location}', 'POST /'],
    ])
  })

  it('offers a way to take an asset back, since nothing else ever reclaims one', () => {
    // The exemption from the retention sweep is what makes this load-bearing rather than a
    // convenience. A candidate pass stages several files per subject and a person keeps one; the
    // rest are ordinary stored assets on no clock at all. With no discard operation the
    // second-phase brief's "remove the staged files where the storage service allows it" resolves,
    // on the one service every deployment has, to "it does not", and the shipped Media preset
    // accumulates every rejected render for the life of the workspace.
    const document = JSON.parse(definition.contracts![0]!.body)
    expect(document.paths['/{location}'].delete.operationId).toBe('discardAsset')
  })

  it('hands each registry its own definition object', () => {
    // Definitions are held BY REFERENCE, so a shared module-level literal would let one
    // deployment's mutation reach another's catalog in a process running several.
    expect(platformAssetStorageService()).not.toBe(platformAssetStorageService())
  })
})
