import { describe, expect, it } from 'vitest'
import { ENV_VARS, optionsFromEnv, selectTools } from '../src/config.ts'
import { CAT_FACTORY_TOOLS } from '../src/tools.generated.ts'

// Configuration is where an MCP server fails in the way nobody notices: a host reports it as
// connected, and the model discovers over several turns that everything is off or broken. So the
// rules pinned here are all about failing at STARTUP instead.

const BASE = {
  [ENV_VARS.baseUrl]: 'https://cat-factory.test',
  [ENV_VARS.apiKey]: 'cf_live_key.secret',
}

describe('optionsFromEnv', () => {
  it('reads the deployment and the key', () => {
    expect(optionsFromEnv(BASE)).toEqual({
      baseUrl: 'https://cat-factory.test',
      apiKey: 'cf_live_key.secret',
    })
  })

  it('refuses to start without credentials, naming what is missing', () => {
    expect(() => optionsFromEnv({})).toThrow(ENV_VARS.baseUrl)
    expect(() => optionsFromEnv({ [ENV_VARS.baseUrl]: 'https://x.test' })).toThrow(ENV_VARS.apiKey)
  })

  it('parses the optional filters', () => {
    const options = optionsFromEnv({
      ...BASE,
      [ENV_VARS.groups]: 'tasks, debug',
      [ENV_VARS.readOnly]: 'true',
      [ENV_VARS.maxResultChars]: '5000',
    })
    expect(options.groups).toEqual(['tasks', 'debug'])
    expect(options.readOnly).toBe(true)
    expect(options.maxResultChars).toBe(5_000)
  })

  it('throws on a mistyped ceiling rather than reverting to the default', () => {
    // Everything numeric here is a LIMIT. Falling back silently would leave an operator believing
    // a cap is in force that is not, which is worse than not starting.
    expect(() => optionsFromEnv({ ...BASE, [ENV_VARS.maxResultChars]: 'lots' })).toThrow(
      ENV_VARS.maxResultChars,
    )
    expect(() => optionsFromEnv({ ...BASE, [ENV_VARS.timeoutMs]: '-1' })).toThrow(
      ENV_VARS.timeoutMs,
    )
  })
})

describe('selectTools', () => {
  const options = { baseUrl: 'https://x.test', apiKey: 'k' }

  it('exposes everything by default', () => {
    const { exposed, filteredGroups } = selectTools(CAT_FACTORY_TOOLS, options)
    expect(exposed).toHaveLength(CAT_FACTORY_TOOLS.length)
    expect(filteredGroups).toEqual([])
  })

  it('reports what a group filter switched OFF, not just what it left on', () => {
    // The server states this in its instructions. Without it a model reads an absent group as a
    // capability the deployment lacks, and tells its user so.
    const { exposed, filteredGroups } = selectTools(CAT_FACTORY_TOOLS, {
      ...options,
      groups: ['tasks'],
    })
    expect(exposed.every((tool) => tool.group === 'tasks')).toBe(true)
    expect(filteredGroups).toContain('debug')
    expect(filteredGroups).not.toContain('tasks')
  })

  it('rejects an unknown group instead of exposing nothing', () => {
    // A typo that resolved to an empty selection looks exactly like a working server whose model
    // never calls anything.
    expect(() => selectTools(CAT_FACTORY_TOOLS, { ...options, groups: ['task'] })).toThrow('task')
  })

  it('keeps only the non-mutating tools in read-only mode', () => {
    const { exposed, writeToolsHidden } = selectTools(CAT_FACTORY_TOOLS, {
      ...options,
      readOnly: true,
    })
    expect(writeToolsHidden).toBe(true)
    expect(exposed.length).toBeGreaterThan(0)
    expect(exposed.every((tool) => tool.readOnly)).toBe(true)
  })
})
