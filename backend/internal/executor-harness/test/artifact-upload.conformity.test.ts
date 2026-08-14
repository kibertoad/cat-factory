import { ASSET_UPLOAD_TOKEN_ENV, ASSET_UPLOAD_URL_ENV } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { ARTIFACT_UPLOAD_TOKEN_ENV, ARTIFACT_UPLOAD_URL_ENV } from '../src/artifact-upload.js'

// The upload seam's env-var names exist TWICE, and this pins the pair.
//
// The harness OWNS them: it is what actually writes the two variables into the agent's child
// process. Kernel restates them because the platform's own asset-storage contract (the OpenAPI
// document a media step's agent reads) NAMES them as where the endpoint and its credential are
// to be found, and the container image builds from `src/` plus typescript alone, so the harness
// can depend on no workspace package and kernel cannot import it back. It is the same
// copy-with-a-pin arrangement `host-markdown.ts` and the failure-cause union already run under.
//
// The drift this catches is silent in the worst way. Renaming one side leaves a contract telling
// an agent to read `$SOMETHING` that nothing sets, which the brief's own wording then reads as
// "the platform could not provide storage", so the run reports a storage outage on a deployment
// whose storage is fine, and no test of either half fails on its own.
describe('the asset-upload env names kernel documents match the ones the harness sets', () => {
  it('names the same URL variable', () => {
    expect(ASSET_UPLOAD_URL_ENV).toBe(ARTIFACT_UPLOAD_URL_ENV)
  })

  it('names the same credential variable', () => {
    expect(ASSET_UPLOAD_TOKEN_ENV).toBe(ARTIFACT_UPLOAD_TOKEN_ENV)
  })
})
