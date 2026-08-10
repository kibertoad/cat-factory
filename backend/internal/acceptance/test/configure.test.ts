import { describe, expect, it } from 'vitest'
import { configure, type ConfigureClient } from '../src/configure.ts'
import { mergeEnvFile, REPO_CREATION_URL, SECRET_KEYS } from '../src/configureEnv.ts'

// What is worth pinning about a setup command is what it PROMISES, because each promise fails
// silently: a merge that loses a hand-added variable looks like a successful write, a token echoed
// into the summary looks like ordinary output, and a value resolved from the deployment looks
// identical to one the operator was asked for and typed again.
//
// So these drive the whole flow through its seams rather than testing the prompts: no deployment, no
// cluster, no terminal.

type Script = {
  answers?: Record<string, string>
  secrets?: string[]
  confirms?: Record<string, boolean>
  selects?: Record<string, string>
}

/**
 * An `Io` whose replies are matched by a SUBSTRING of the prompt.
 *
 * Substring rather than exact text so a reworded prompt does not silently start answering with its
 * default, which is the one failure a fake like this can hide.
 */
function fakeIo(script: Script = {}) {
  const output: string[] = []
  const opened: string[] = []
  const prompted: string[] = []
  /** Every menu label the flow offered, which is where the preset's availability marking lands. */
  const offered: string[] = []
  const secrets = [...(script.secrets ?? [])]
  let asks = 0
  const find = <T>(table: Record<string, T> | undefined, prompt: string): T | undefined => {
    const hit = Object.entries(table ?? {}).find(([key]) => prompt.includes(key))
    return hit?.[1]
  }
  const guard = (prompt: string): void => {
    prompted.push(prompt)
    // A loop this command can genuinely enter (re-check a repository until it appears) would
    // otherwise hang the suite rather than fail it.
    if (++asks > 100) throw new Error(`configure asked over 100 questions; last: '${prompt}'`)
  }
  return {
    output,
    opened,
    prompted,
    offered,
    io: {
      info: (message: string) => void output.push(message),
      warn: (message: string) => void output.push(message),
      question: async (prompt: string, defaultValue?: string) => {
        guard(prompt)
        return find(script.answers, prompt) ?? defaultValue ?? ''
      },
      secret: async (prompt: string) => {
        guard(prompt)
        return secrets.shift() ?? ''
      },
      confirm: async (prompt: string, defaultValue: boolean) => {
        guard(prompt)
        return find(script.confirms, prompt) ?? defaultValue
      },
      select: async <T extends string>(
        prompt: string,
        options: readonly { value: T; label: string }[],
        defaultValue: T,
      ) => {
        guard(prompt)
        offered.push(...options.map((option) => option.label))
        return (find(script.selects, prompt) as T | undefined) ?? defaultValue
      },
      openBrowser: async (url: string) => void opened.push(url),
    },
  }
}

/** A `HostShell` answering the two kubeconfig reads, and nothing else. */
function fakeShell(results: Record<string, { code: number; stdout: string }> = {}) {
  return {
    run: async (cmd: string, args: string[]) => {
      const line = [cmd, ...args].join(' ')
      const hit = Object.entries(results).find(([key]) => line.includes(key))
      return { code: hit?.[1].code ?? 1, stdout: hit?.[1].stdout ?? '', stderr: '' }
    },
  }
}

function fakeClient(overrides: Partial<ConfigureClient> = {}): ConfigureClient {
  return {
    identity: async () => ({ workspaceId: 'ws_live', scope: 'admin', label: 'acceptance' }),
    connection: async () => ({ accountLogin: 'acme', provider: 'github' as const }),
    repos: async () => [
      { owner: 'acme', name: 'cf-acc-catalog-api', serviceId: null },
      { owner: 'acme', name: 'cf-acc-catalog-web', serviceId: null },
    ],
    presets: async () => [
      {
        presetId: 'mdp_claude',
        name: 'Claude Opus 5',
        baseModelId: 'claude-opus',
        isDefault: true,
      },
    ],
    models: async () => [{ modelId: 'claude-opus', available: true }],
    ...overrides,
  }
}

/** Run the flow over an in-memory `.env`, returning the written text and everything printed. */
async function run(options: {
  script?: Script
  existing?: string | null
  client?: ConfigureClient
  shell?: Record<string, { code: number; stdout: string }>
}) {
  const io = fakeIo(options.script)
  let written: string | null = null
  const outcome = await configure({
    io: io.io,
    shell: fakeShell(options.shell ?? { 'config view': { code: 0, stdout: 'https://k8s:6443\n' } }),
    envPath: '/tmp/.env',
    readFile: () => options.existing ?? null,
    writeFile: (_path, text) => void (written = text),
    connect: () => options.client ?? fakeClient(),
  })
  return { outcome, written: written as string | null, io }
}

const TOKEN = 'cf_live_pak_secret.value'

describe('configure', () => {
  it('resolves the workspace and the owner instead of asking for them', async () => {
    // The rule the whole command is built on: the deployment already knows both, and a question is
    // one more value to paste wrongly.
    const { written, io } = await run({ script: { secrets: [TOKEN] } })
    expect(written).toContain('ACCEPTANCE_WORKSPACE_ID=ws_live')
    expect(written).toContain('ACCEPTANCE_REPO_OWNER=acme')
    expect(io.prompted.join('\n')).not.toContain('Workspace')
    expect(io.output.join('\n')).toContain('Resolved workspace ws_live')
  })

  it('never prints the token, in the summary or anywhere else', async () => {
    const { written, io } = await run({ script: { secrets: [TOKEN] } })
    expect(written).toContain(`CAT_FACTORY_API_KEY=${TOKEN}`)
    expect(io.output.join('\n')).not.toContain(TOKEN)
    expect(io.output.join('\n')).toContain('CAT_FACTORY_API_KEY=(set, not shown)')
  })

  it('reuses a stored token without showing it, and only replaces it when asked', async () => {
    const existing = `CAT_FACTORY_API_KEY=${TOKEN}\n`
    const kept = await run({ existing, script: { secrets: ['typed-by-mistake'] } })
    expect(kept.written).toContain(`CAT_FACTORY_API_KEY=${TOKEN}`)
    expect(kept.io.output.join('\n')).not.toContain(TOKEN)

    const replaced = await run({
      existing,
      script: { secrets: ['a-new-token'], confirms: { 'Replace the stored API token': true } },
    })
    expect(replaced.written).toContain('CAT_FACTORY_API_KEY=a-new-token')
  })

  it('refuses to write anything when there is no token to resolve the rest with', async () => {
    const { outcome, written, io } = await run({ script: { secrets: [''] } })
    expect(outcome.ok).toBe(false)
    expect(written).toBeNull()
    expect(io.output.join('\n')).toContain('Full access')
  })

  it('says which values it replaced, and leaves what it does not manage alone', async () => {
    // The PEM is the case that makes this more than bookkeeping: it is a multi-line quoted value
    // this command does not manage, and a merge that re-rendered it from a parse is how it acquires
    // a stray escape and stops matching the cluster's certificate.
    const existing = [
      'CAT_FACTORY_BASE_URL=http://old:9999',
      '# my own note',
      'ACCEPTANCE_K3S_CA_PEM="-----BEGIN CERTIFICATE-----',
      'AAAA',
      '-----END CERTIFICATE-----"',
      'ACCEPTANCE_RUN_BUDGET_MS=1200000',
      '',
    ].join('\n')
    const { written, io } = await run({
      existing,
      script: { secrets: [TOKEN], answers: { 'Backend origin': 'http://new:8787' } },
    })
    expect(written).toContain('ACCEPTANCE_K3S_CA_PEM="-----BEGIN CERTIFICATE-----\nAAAA\n')
    expect(written).toContain('ACCEPTANCE_RUN_BUDGET_MS=1200000')
    expect(written).toContain('# my own note')
    const printed = io.output.join('\n')
    expect(printed).toContain('replaced: CAT_FACTORY_BASE_URL')
    expect(printed).toContain('left alone (not managed here): ACCEPTANCE_K3S_CA_PEM')
  })

  it('opens the creation page for a repository the workspace cannot see, then re-checks', async () => {
    let listed = false
    const client = fakeClient({
      repos: async () =>
        listed
          ? [
              { owner: 'acme', name: 'cf-acc-catalog-api', serviceId: null },
              { owner: 'acme', name: 'cf-acc-catalog-web', serviceId: null },
            ]
          : [{ owner: 'acme', name: 'cf-acc-catalog-web', serviceId: null }],
    })
    const io = fakeIo({ secrets: [TOKEN] })
    // The operator creates it between the offer and the re-check, which is exactly the sequence the
    // loop exists for: the alternative is discovering the miss at the start of an afternoon.
    const original = io.io.confirm
    io.io.confirm = async (prompt: string, defaultValue: boolean) => {
      if (prompt.includes('Re-check')) listed = true
      return original(prompt, defaultValue)
    }
    await configure({
      io: io.io,
      shell: fakeShell({ 'config view': { code: 0, stdout: 'https://k8s:6443' } }),
      envPath: '/tmp/.env',
      readFile: () => null,
      writeFile: () => {},
      connect: () => client,
    })
    expect(io.opened).toEqual([
      'https://github.com/new?name=cf-acc-catalog-api&owner=acme&visibility=private',
    ])
    expect(io.output.join('\n')).toContain('cf-acc-catalog-api is visible')
  })

  it('never reports a failed read as a negative answer', async () => {
    // The three-state rule the prerequisite gate is built on, applied to a command that resolves
    // rather than grades: "no VCS connection" and "the connection read failed" send an operator to
    // fix different things, and so do "this workspace holds no presets" and "the library would not
    // load". A `.catch(() => null)` per read is what this replaced.
    const { io } = await run({
      client: fakeClient({
        connection: async () => {
          throw new Error('502 upstream')
        },
        presets: async () => {
          throw new Error('503 unavailable')
        },
        repos: async () => {
          throw new Error('500 boom')
        },
      }),
      script: { secrets: [TOKEN] },
    })
    const printed = io.output.join('\n')
    expect(printed).toContain('NOT a verdict that nothing is connected')
    expect(printed).toContain('unknown rather than answered no')
    expect(printed).toContain('could not be read (503 unavailable)')
    expect(printed).not.toContain('has no source-control connection')
  })

  it('lists presets unmarked when the catalog is unreadable, rather than marked unavailable', async () => {
    // "We could not check" and "no provider is wired" are opposite facts, and only the second would
    // stop an operator picking the preset that actually works.
    const unreadable = await run({
      client: fakeClient({
        models: async () => {
          throw new Error('catalog down')
        },
      }),
      script: { secrets: [TOKEN] },
    })
    expect(unreadable.io.output.join('\n')).toContain('without saying which can be dispatched to')
    expect(unreadable.io.offered).toEqual(['Claude Opus 5 (claude-opus) [workspace default]'])

    // The same preset, with a catalog that ANSWERED: now the marking is a fact and is shown.
    const answered = await run({
      client: fakeClient({ models: async () => [{ modelId: 'claude-opus', available: false }] }),
      script: { secrets: [TOKEN] },
    })
    expect(answered.io.offered).toEqual([
      'Claude Opus 5 (claude-opus) (no provider wired for it) [workspace default]',
    ])
  })

  it('withholds a creation link on GitLab rather than linking gitlab.com', async () => {
    // `GET /api/v1/vcs/connection` publishes no instance URL, so the only link this code could
    // build for a self-hosted GitLab is a stranger's server.
    const { io } = await run({
      client: fakeClient({
        connection: async () => ({ accountLogin: 'acme', provider: 'gitlab' as const }),
        repos: async () => [],
      }),
      script: { secrets: [TOKEN], confirms: { 'Re-check': false } },
    })
    expect(io.opened).toEqual([])
    expect(io.output.join('\n')).toContain('on your provider')
  })

  it('writes the .env even with a repository still missing, and says the gate will refuse', async () => {
    // Nine correct answers are worth keeping. The prerequisite gate names the tenth again with its
    // own remedy, so refusing here would only make the operator retype the rest.
    const { outcome, written, io } = await run({
      client: fakeClient({ repos: async () => [] }),
      script: { secrets: [TOKEN], confirms: { 'Re-check': false } },
    })
    expect(outcome.ok).toBe(true)
    expect(written).toContain('ACCEPTANCE_BACKEND_REPO=cf-acc-catalog-api')
    expect(io.output.join('\n')).toContain("'target-repos' prerequisite will refuse")
  })

  it('preselects a preset whose model is wired over the workspace default that is not', async () => {
    const { written, io } = await run({
      client: fakeClient({
        presets: async () => [
          { presetId: 'mdp_claude', name: 'Claude', baseModelId: 'claude-opus', isDefault: true },
          { presetId: 'mdp_kimi', name: 'Kimi', baseModelId: 'kimi', isDefault: false },
        ],
        models: async () => [
          { modelId: 'claude-opus', available: false },
          { modelId: 'kimi', available: true },
        ],
      }),
      script: { secrets: [TOKEN] },
    })
    expect(written).toContain('ACCEPTANCE_MODEL_PRESET=mdp_kimi')
    expect(io.prompted.join('\n')).toContain('Model preset')
  })

  it('reads the cluster out of the kubeconfig, and asks only for what it could not read', async () => {
    const { written, io } = await run({
      script: { secrets: [TOKEN, 'typed-sa-token'] },
      shell: {
        'config view': { code: 0, stdout: 'https://127.0.0.1:6443/\n' },
        'get secret': { code: 1, stdout: '' },
      },
    })
    // The trailing slash is stripped here as it is in `resolveConfig`, so a pasted URL and a
    // resolved one produce the same base.
    expect(written).toContain('ACCEPTANCE_K3S_API_SERVER=https://127.0.0.1:6443\n')
    expect(written).toContain('ACCEPTANCE_K3S_TOKEN=typed-sa-token')
    expect(io.output.join('\n')).toContain('Resolved apiserver https://127.0.0.1:6443')
  })

  it('decodes the ServiceAccount token the cluster holds rather than asking for it', async () => {
    const { written, io } = await run({
      script: { secrets: [TOKEN] },
      shell: {
        'config view': { code: 0, stdout: 'https://k8s:6443' },
        'get secret': { code: 0, stdout: Buffer.from('cluster-token').toString('base64') },
      },
    })
    expect(written).toContain('ACCEPTANCE_K3S_TOKEN=cluster-token')
    expect(io.output.join('\n')).not.toContain('cluster-token')
  })

  it('warns about an under-scoped key without abandoning the file', async () => {
    const { outcome, io } = await run({
      client: fakeClient({
        identity: async () => ({ workspaceId: 'ws_live', scope: 'write', label: 'acceptance' }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(outcome.ok).toBe(true)
    expect(io.output.join('\n')).toContain("scoped 'write'")
  })

  it('reports an unreachable deployment as the origin or the token, not as a missing answer', async () => {
    const { outcome, written, io } = await run({
      client: fakeClient({
        identity: async () => {
          throw new Error('fetch failed')
        },
      }),
      script: { secrets: [TOKEN] },
    })
    expect(outcome.ok).toBe(false)
    expect(written).toBeNull()
    expect(io.output.join('\n')).toContain('fetch failed')
    expect(io.output.join('\n')).toContain('the SPA serves a /health of its own')
  })
})

describe('mergeEnvFile', () => {
  it('categorises every key so nothing is overwritten without a word about it', () => {
    const merge = mergeEnvFile('A=1\nB=2\nC=3\n', [
      { key: 'A', value: '1' },
      { key: 'B', value: 'changed' },
      { key: 'D', value: 'new' },
    ])
    expect(merge.kept).toEqual(['A'])
    expect(merge.changed).toEqual(['B'])
    expect(merge.added).toEqual(['D'])
    expect(merge.preserved).toEqual(['C'])
  })

  it('reads `export FOO=bar` and a quoted value as the same assignment', () => {
    // Both spellings appear in a hand-written `.env`, and reading either as a different key would
    // have this command write a second copy of it beside the first.
    const merge = mergeEnvFile('export A="1"\n', [{ key: 'A', value: '1' }])
    expect(merge.kept).toEqual(['A'])
    expect(merge.text).toBe('A=1\n')
  })

  it('drops the comment block above a key it rewrites, so no comment outlives its value', () => {
    const merge = mergeEnvFile('# describes A\nA=old\nB=keep\n', [
      { key: 'A', value: 'new', comment: ['the current description'] },
    ])
    expect(merge.text).toContain('# the current description\nA=new')
    expect(merge.text).not.toContain('# describes A')
    expect(merge.text).toContain('B=keep')
  })

  it('writes a whole file when there was none', () => {
    const merge = mergeEnvFile(null, [{ key: 'A', value: '1' }])
    expect(merge.text).toBe('A=1\n')
    expect(merge.added).toEqual(['A'])
    expect(merge.preserved).toEqual([])
  })
})

describe('REPO_CREATION_URL', () => {
  it('prefills the name, owner and visibility on GitHub', () => {
    expect(REPO_CREATION_URL.github('acme', 'cf-acc-catalog-api')).toBe(
      'https://github.com/new?name=cf-acc-catalog-api&owner=acme&visibility=private',
    )
  })

  it('answers null for GitLab, whose instance URL this platform cannot know', () => {
    expect(REPO_CREATION_URL.gitlab('acme', 'cf-acc-catalog-api')).toBeNull()
  })
})

describe('SECRET_KEYS', () => {
  it('lists every managed variable that carries a credential', () => {
    // Listed rather than pattern-matched, so a new secret whose name does not say `TOKEN` cannot
    // slip into a printed summary. Derived from the same set the writer uses.
    expect([...SECRET_KEYS].sort()).toEqual(['ACCEPTANCE_K3S_TOKEN', 'CAT_FACTORY_API_KEY'])
  })
})
