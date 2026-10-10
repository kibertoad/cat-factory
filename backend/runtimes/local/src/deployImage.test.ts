import { describe, expect, it } from 'vitest'
import { RECOMMENDED_DEPLOY_IMAGE, resolveDeployImage } from './deployImage.js'

describe('resolveDeployImage', () => {
  it('defaults to the backend-matched RECOMMENDED_DEPLOY_IMAGE when LOCAL_DEPLOY_IMAGE is unset', () => {
    expect(resolveDeployImage({})).toBe(RECOMMENDED_DEPLOY_IMAGE)
  })

  it('uses an explicit LOCAL_DEPLOY_IMAGE as an escape hatch (trimmed)', () => {
    expect(
      resolveDeployImage({ LOCAL_DEPLOY_IMAGE: '  ghcr.io/acme/cat-factory-deploy:9.9.9  ' }),
    ).toBe('ghcr.io/acme/cat-factory-deploy:9.9.9')
  })

  it('falls back to the recommended image for a blank LOCAL_DEPLOY_IMAGE', () => {
    expect(resolveDeployImage({ LOCAL_DEPLOY_IMAGE: '   ' })).toBe(RECOMMENDED_DEPLOY_IMAGE)
  })

  it('recommends an immutable semver tag (never a mutable :latest)', () => {
    expect(RECOMMENDED_DEPLOY_IMAGE).toMatch(/:\d+\.\d+\.\d+$/)
  })
})
