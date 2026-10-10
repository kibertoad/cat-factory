import { ASSET_STORAGE_CAPABILITY, BINARY_OUTPUT_DECLARATION_TAG } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { BINARY_OUTPUT_GUIDANCE, BINARY_OUTPUT_TRAIT, BINARY_STORAGE_TRAIT } from './traits.js'

// This package is the ONLY one that can see both vocabularies at once: kernel owns the catalog
// CAPABILITY tags and cannot import the agents package's TRAITS. So the pins that keep the two
// apart live here.

describe('binary-output vocabulary', () => {
  it('keeps the catalog storage CAPABILITY distinct from the platform-store TRAIT', () => {
    // These mean opposite things about opposite subjects:
    //  - BINARY_STORAGE_TRAIT marks a KIND as needing the PLATFORM's binary-artifact store for
    //    run EVIDENCE (the UI Tester's screenshots, read back by the visual-confirmation gate).
    //  - ASSET_STORAGE_CAPABILITY marks a catalog SERVICE as a legal target for a generator's
    //    product assets.
    // They once shared the literal 'binary-storage', and `RunAdmission` imports both. A capability
    // tag is a free-form string, so swapping them typechecked and no behavioural test could tell:
    // the run would refuse (or admit) for a reason nobody wrote down. Keep them apart.
    expect(ASSET_STORAGE_CAPABILITY).not.toBe(BINARY_STORAGE_TRAIT)
    expect(BINARY_OUTPUT_TRAIT).not.toBe(BINARY_STORAGE_TRAIT)
  })

  it('names the declaration tag in the guidance, so prompt and parser cannot drift', () => {
    // The parser looks for exactly this fence; the guidance is the only place the agent is told
    // about it. Renaming one without the other yields a run that stores artifacts and records
    // none, with nothing failing.
    expect(BINARY_OUTPUT_GUIDANCE).toContain(`\`\`\`${BINARY_OUTPUT_DECLARATION_TAG}`)
  })
})
