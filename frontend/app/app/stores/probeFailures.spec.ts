import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { useSkillLibrary } from '~/stores/skillLibrary'
import { useReleaseHealthStore } from '~/stores/releaseHealth'
import { useInfraConfigStore } from '~/stores/infraConfig'
import { useAccountSettingsStore } from '~/stores/accountSettings'
import { useWorkspaceStore } from '~/stores/workspace'

// Each of these stores gates a whole surface on `available`. Only a 503 means the deployment did
// not wire the feature; any other failure is a read that did not answer, and it must reach the
// surface as `loadFailed` rather than as a switched-off feature (AGENTS.md, "Degrade loudly").

const unavailable = () => new ApiError(503, { error: { code: 'unavailable', message: 'off' } })
const broken = () => new ApiError(500, { error: { code: 'internal', message: 'boom' } })
// A 503 with no envelope: a proxy or platform outage, not the deployment saying "not wired".
const outage = () => new ApiError(503, 'Service Unavailable')

describe('skill library probe', () => {
  it('a 503 turns the library off', async () => {
    vi.stubGlobal('useApi', () => ({ listAccountSkills: () => Promise.reject(unavailable()) }))
    const store = useSkillLibrary('acc1')
    await store.probe()
    expect(store.available).toBe(false)
    expect(store.loadFailed).toBe(false)
  })

  it('any other failure is a failed load, and a later success clears it', async () => {
    let fail = true
    vi.stubGlobal('useApi', () => ({
      listAccountSkills: () => (fail ? Promise.reject(broken()) : Promise.resolve([])),
      listSkillSources: () => Promise.resolve([]),
    }))
    const store = useSkillLibrary('acc2')
    await store.probe()
    expect(store.available).toBeNull()
    expect(store.loadFailed).toBe(true)

    fail = false
    await store.probe()
    expect(store.available).toBe(true)
    expect(store.loadFailed).toBe(false)
  })
})

describe('release-health load', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('a 503 turns observability off and resolves', async () => {
    vi.stubGlobal('useApi', () => ({
      getObservabilityConnection: () => Promise.reject(unavailable()),
      listReleaseHealthConfigs: () => Promise.resolve([]),
    }))
    const store = useReleaseHealthStore()
    await store.load()
    expect(store.available).toBe(false)
    expect(store.loadFailed).toBe(false)
  })

  it('any other failure is recorded, rethrown, and asked again by ensureLoaded', async () => {
    const getObservabilityConnection = vi
      .fn()
      .mockRejectedValueOnce(broken())
      .mockResolvedValue({ connected: true, provider: 'datadog', summary: null })
    vi.stubGlobal('useApi', () => ({
      getObservabilityConnection,
      listReleaseHealthConfigs: () => Promise.resolve([]),
    }))
    const store = useReleaseHealthStore()
    await expect(store.ensureLoaded()).rejects.toThrow('boom')
    expect(store.available).toBeNull()
    expect(store.loadFailed).toBe(true)

    await store.ensureLoaded()
    expect(getObservabilityConnection).toHaveBeenCalledTimes(2)
    expect(store.available).toBe(true)
    expect(store.loadFailed).toBe(false)
  })
})

describe('infra-config load', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('a 503 turns the configurator off', async () => {
    vi.stubGlobal('useApi', () => ({
      listEnvironmentHandlers: () => Promise.reject(unavailable()),
    }))
    const store = useInfraConfigStore()
    await store.load()
    expect(store.available).toBe(false)
    expect(store.loadFailed).toBe(false)
  })

  it('any other failure is a failed load, and ensureLoaded asks again', async () => {
    const listEnvironmentHandlers = vi
      .fn()
      .mockRejectedValueOnce(broken())
      .mockResolvedValue({ handlers: [], customTypes: [] })
    vi.stubGlobal('useApi', () => ({ listEnvironmentHandlers }))
    const store = useInfraConfigStore()
    await store.ensureLoaded()
    expect(store.available).toBeNull()
    expect(store.loadFailed).toBe(true)

    await store.ensureLoaded()
    expect(listEnvironmentHandlers).toHaveBeenCalledTimes(2)
    expect(store.available).toBe(true)
    expect(store.loadFailed).toBe(false)
  })
})

describe('release-health incident load', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('a module-off 503 turns the incident section off', async () => {
    vi.stubGlobal('useApi', () => ({ getIncidentEnrichment: () => Promise.reject(unavailable()) }))
    const store = useReleaseHealthStore()
    await store.loadIncident()
    expect(store.incidentAvailable).toBe(false)
    expect(store.incidentLoadFailed).toBe(false)
  })

  it('any other failure is a failed load, and a later success clears it', async () => {
    const getIncidentEnrichment = vi
      .fn()
      .mockRejectedValueOnce(broken())
      .mockResolvedValue({ connected: true, summary: null })
    vi.stubGlobal('useApi', () => ({ getIncidentEnrichment }))
    const store = useReleaseHealthStore()
    await store.loadIncident()
    expect(store.incidentAvailable).toBeNull()
    expect(store.incidentLoadFailed).toBe(true)

    await store.loadIncident()
    expect(store.incidentAvailable).toBe(true)
    expect(store.incidentLoadFailed).toBe(false)
  })
})

describe('account settings load', () => {
  it('a module-off 503 hides the panel and resolves', async () => {
    vi.stubGlobal('useApi', () => ({ getAccountSettings: () => Promise.reject(unavailable()) }))
    const store = useAccountSettingsStore()
    await store.load('acc1')
    expect(store.available).toBe(false)
  })

  it('an outage 503 is rethrown for the panel to state, not read as "not enabled"', async () => {
    vi.stubGlobal('useApi', () => ({ getAccountSettings: () => Promise.reject(outage()) }))
    const store = useAccountSettingsStore()
    await expect(store.load('acc1')).rejects.toBeInstanceOf(ApiError)
    expect(store.available).toBeNull()
  })
})
