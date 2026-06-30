import { describe, expect, it } from 'vitest'
import { decideTesterInfra, type TesterInfraInput } from './tester-infra.logic.js'

const base: TesterInfraInput = {
  provisionType: undefined,
  localTestInfraSupported: true,
  handlerResolves: true,
}

describe('decideTesterInfra', () => {
  it('passes when no provisioning is declared (run with no infra)', () => {
    expect(decideTesterInfra({ ...base, provisionType: undefined })).toEqual({ ok: true })
  })

  it('passes an `infraless` service', () => {
    expect(decideTesterInfra({ ...base, provisionType: 'infraless' })).toEqual({ ok: true })
  })

  describe('docker-compose (stood up in-container)', () => {
    it('passes on a DinD-capable runtime', () => {
      expect(
        decideTesterInfra({
          ...base,
          provisionType: 'docker-compose',
          localTestInfraSupported: true,
        }),
      ).toEqual({ ok: true })
    })

    it('refuses on a runtime that cannot nest containers (Apple `container`)', () => {
      expect(
        decideTesterInfra({
          ...base,
          provisionType: 'docker-compose',
          localTestInfraSupported: false,
        }),
      ).toEqual({ ok: false, reason: 'limited-local' })
    })
  })

  describe('kubernetes / custom (provisioned by a workspace handler)', () => {
    for (const provisionType of ['kubernetes', 'custom'] as const) {
      it(`passes a ${provisionType} service when a handler resolves`, () => {
        expect(decideTesterInfra({ ...base, provisionType, handlerResolves: true })).toEqual({
          ok: true,
        })
      })

      it(`refuses a ${provisionType} service when no handler resolves`, () => {
        expect(decideTesterInfra({ ...base, provisionType, handlerResolves: false })).toEqual({
          ok: false,
          reason: 'provision-type-unhandled',
        })
      })
    }
  })
})
