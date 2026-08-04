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
    // ...and names the file variable too, since either one satisfies the requirement.
    expect(() => optionsFromEnv({ [ENV_VARS.baseUrl]: 'https://x.test' })).toThrow(
      ENV_VARS.apiKeyFile,
    )
  })

  describe('the key file', () => {
    it('reads the key out of the file the variable names', () => {
      const options = optionsFromEnv(
        {
          [ENV_VARS.baseUrl]: 'https://cat-factory.test',
          [ENV_VARS.apiKeyFile]: '/run/secrets/cat-factory',
        },
        // A trailing newline is what every secrets mount and every `echo > file` leaves behind, and
        // it would otherwise ride into the Authorization header.
        { readSecretFile: () => 'cf_live_key.secret\n' },
      )
      expect(options.apiKey).toBe('cf_live_key.secret')
    })

    it('refuses both sources at once rather than picking one', () => {
      // Two live sources for one credential means a rotation can land on the half nobody reads, and
      // the deployment goes on working with the old key until it is revoked.
      expect(() =>
        optionsFromEnv({ ...BASE, [ENV_VARS.apiKeyFile]: '/run/secrets/cat-factory' }),
      ).toThrow(ENV_VARS.apiKeyFile)
    })

    it('names the path but never the contents when the file cannot be used', () => {
      const unreadable = () =>
        optionsFromEnv(
          {
            [ENV_VARS.baseUrl]: 'https://cat-factory.test',
            [ENV_VARS.apiKeyFile]: '/run/secrets/absent',
          },
          {
            readSecretFile: () => {
              throw new Error('ENOENT: no such file or directory')
            },
          },
        )
      expect(unreadable).toThrow('/run/secrets/absent')
      expect(unreadable).toThrow('ENOENT')
      // An empty file is its own failure: it would otherwise mint a server with a blank key that
      // 401s on every call.
      expect(() =>
        optionsFromEnv(
          {
            [ENV_VARS.baseUrl]: 'https://cat-factory.test',
            [ENV_VARS.apiKeyFile]: '/run/secrets/blank',
          },
          { readSecretFile: () => '  \n' },
        ),
      ).toThrow('empty')
    })
  })

  it('parses the optional filters', () => {
    const options = optionsFromEnv({
      ...BASE,
      [ENV_VARS.groups]: 'tasks, debug',
      [ENV_VARS.tools]: 'tasks_get,tasks_start',
      [ENV_VARS.excludeTools]: ' tasks_start ',
      [ENV_VARS.readOnly]: 'true',
      [ENV_VARS.maxResultChars]: '5000',
      [ENV_VARS.timeoutMs]: '30000',
      [ENV_VARS.maxRetries]: '2',
    })
    expect(options.groups).toEqual(['tasks', 'debug'])
    expect(options.tools).toEqual(['tasks_get', 'tasks_start'])
    expect(options.excludeTools).toEqual(['tasks_start'])
    expect(options.readOnly).toBe(true)
    expect(options.maxResultChars).toBe(5_000)
    expect(options.timeoutMs).toBe(30_000)
    expect(options.maxRetries).toBe(2)
  })

  it('leaves an unset knob ABSENT rather than explicitly undefined', () => {
    // These are spread onto the SDK's own options, where a present-but-undefined field is not the
    // same as an omitted one: it would override the SDK's default with nothing.
    const options = optionsFromEnv(BASE)
    expect('timeoutMs' in options).toBe(false)
    expect('maxRetries' in options).toBe(false)
    expect('maxResultChars' in options).toBe(false)
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
    expect(() => optionsFromEnv({ ...BASE, [ENV_VARS.maxRetries]: 'many' })).toThrow(
      ENV_VARS.maxRetries,
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

  it('withholds ONE tool without costing its whole group', () => {
    // The reason the per-tool filter exists: keeping the PR-merging tool away from a model used to
    // mean giving up the notification inbox it belongs to.
    const { exposed, deniedTools } = selectTools(CAT_FACTORY_TOOLS, {
      ...options,
      excludeTools: ['notifications_act'],
    })
    expect(exposed.map((tool) => tool.name)).not.toContain('notifications_act')
    expect(exposed.map((tool) => tool.name)).toContain('notifications_list')
    // Reported, because the server states it in its instructions: a model reading the absence as a
    // missing platform feature will offer to do it some other way.
    expect(deniedTools).toEqual(['notifications_act'])
  })

  it('narrows to an allow-list and says that it did', () => {
    const { exposed, toolsAllowListed } = selectTools(CAT_FACTORY_TOOLS, {
      ...options,
      tools: ['tasks_get', 'tasks_create'],
    })
    expect(exposed.map((tool) => tool.name).sort()).toEqual(['tasks_create', 'tasks_get'])
    expect(toolsAllowListed).toBe(true)
    // The deny-list wins over the allow-list, so a safety entry cannot be undone by adding a name.
    const both = selectTools(CAT_FACTORY_TOOLS, {
      ...options,
      tools: ['tasks_get', 'tasks_create'],
      excludeTools: ['tasks_create'],
    })
    expect(both.exposed.map((tool) => tool.name)).toEqual(['tasks_get'])
  })

  it('rejects an unknown tool name in either filter', () => {
    // A deny-list typo is the dangerous one: `notifications_action` withholds nothing, and the tool
    // the operator meant to keep away from a model goes on being served.
    expect(() =>
      selectTools(CAT_FACTORY_TOOLS, { ...options, excludeTools: ['notifications_action'] }),
    ).toThrow('notifications_action')
    expect(() => selectTools(CAT_FACTORY_TOOLS, { ...options, tools: ['task_get'] })).toThrow(
      'task_get',
    )
    // A redundant deny is not a mistake: the name exists, it is simply already gone.
    expect(() =>
      selectTools(CAT_FACTORY_TOOLS, {
        ...options,
        groups: ['tasks'],
        excludeTools: ['debug_list_runs'],
      }),
    ).not.toThrow()
  })

  it('refuses a combination that would expose no tools at all', () => {
    // A server with nothing on it is reported by the host as connected, and a model with no tools
    // looks exactly like a model that decided not to use any.
    // Two filters that each make sense and cancel out: an allow-list naming a write, on a server
    // also started read-only.
    expect(() =>
      selectTools(CAT_FACTORY_TOOLS, { ...options, tools: ['tasks_start'], readOnly: true }),
    ).toThrow('no tools')
  })
})
