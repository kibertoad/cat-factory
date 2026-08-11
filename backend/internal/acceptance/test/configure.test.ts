import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { configure, type ConfigureClient, type LinkOutcome } from '../src/configure.ts'
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
  /** The reporter token pasted at the `ACCEPTANCE_VCS_TOKEN` prompt. Defaults to a fixed value. */
  reporterToken?: string
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
        // The reporter token is answered by PROMPT rather than by position, and defaulted. It is
        // asked between the API key and the cluster token, so a positional script would have to
        // restate it in every case that answers the one after it, and a case about the CLUSTER
        // would silently be answering this instead.
        if (prompt.includes('Reporter token')) return script.reporterToken ?? REPORTER_TOKEN
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

const REPORTER_TOKEN = 'ghp_reporter_value'

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

/** What `POST /api/v1/repos/link` answered, as `ConfigureClient` narrows the adopted row. */
function adopted(name: string, overrides: Record<string, unknown> = {}): LinkOutcome {
  return {
    status: 'adopted',
    repo: { owner: 'acme', name, serviceId: null, linkedElsewhere: false, monorepo: false },
    ...overrides,
  } as LinkOutcome
}

/**
 * A client whose adopt SUCCEEDS for the two repositories the flow asks about.
 *
 * The default is the ordinary path: the operator names two repositories the connection can reach, and
 * the command adopts both. A test that wants the other outcome overrides `link`.
 */
function fakeClient(overrides: Partial<ConfigureClient> = {}): ConfigureClient {
  return {
    identity: async () => ({ workspaceId: 'ws_live', scope: 'admin', label: 'acceptance' }),
    connection: async () => ({
      accountLogin: 'acme',
      provider: 'github' as const,
      method: 'pat' as const,
    }),
    link: async (_owner: string, name: string) => adopted(name),
    available: async () => [],
    presets: async () => [
      {
        presetId: 'mdp_claude',
        name: 'Claude Opus 5',
        baseModelId: 'claude-opus',
        isDefault: true,
      },
    ],
    models: async () => ({
      models: [{ modelId: 'claude-opus', available: true }],
      excludesUserScopedModels: false,
    }),
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
})

// The repository half, which is where this command does its one WRITE. Its own block because the
// adopt is a different question from the file: whether the workspace ends up holding what the
// operator named, and what it says when it cannot.
describe('configure: adopting the repositories', () => {
  it('ADOPTS each repository itself rather than asking anyone to link it', async () => {
    // The point of the whole flow: linking is a call, so the command makes it. An operator who names
    // two reachable repositories is asked for nothing and told what happened.
    const linked: string[] = []
    const { io } = await run({
      client: fakeClient({
        link: async (_owner, name) => {
          linked.push(name)
          return adopted(name)
        },
      }),
      // The token page is declined so `opened` below stays a claim about the REPOSITORY: whether
      // this command offers the reporter-token page is its own case further down.
      script: { secrets: [TOKEN], confirms: { 'Open the token page': false } },
    })
    expect(linked).toEqual(['cf-acc-catalog-api', 'cf-acc-catalog-web'])
    const printed = io.output.join('\n')
    expect(printed).toContain('acme/cf-acc-catalog-api is adopted by this workspace')
    expect(io.opened).toEqual([])
    // And nothing sends the operator to the app for a step the platform performs.
    expect(printed).not.toContain('Manage repos')
  })

  it('opens the creation page for a repository the connection cannot reach, then re-checks', async () => {
    let created = false
    const client = fakeClient({
      link: async (_owner, name) =>
        name === 'cf-acc-catalog-api' && !created ? { status: 'unreachable' } : adopted(name),
    })
    const io = fakeIo({ secrets: [TOKEN], confirms: { 'Open the token page': false } })
    // The operator creates it between the offer and the re-check, which is exactly the sequence the
    // loop exists for: the alternative is discovering the miss at the start of an afternoon.
    const original = io.io.confirm
    io.io.confirm = async (prompt: string, defaultValue: boolean) => {
      if (prompt.includes('Re-check')) created = true
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
    expect(io.output.join('\n')).toContain('cf-acc-catalog-api is adopted')
  })

  it('states the outcome of every attempt, and what to do about a negative one', async () => {
    // Two properties, and each fails silently: the attempt's OUTCOME is printed whether or not it
    // succeeded (a silent negative is indistinguishable from a command that did nothing), and a
    // negative one carries what only a person can fix.
    const { io } = await run({
      client: fakeClient({
        link: async () => ({ status: 'unreachable' }),
        // The same NAME under another owner, which is the one thing that separates a typo in
        // ACCEPTANCE_REPO_OWNER from a credential that reaches nothing.
        available: async () => [{ owner: 'someone-else', name: 'cf-acc-catalog-api' }],
      }),
      script: { secrets: [TOKEN], confirms: { 'Re-check': false } },
    })
    const printed = io.output.join('\n')
    expect(printed).toContain("acme/cf-acc-catalog-api is not reachable by this workspace's")
    expect(printed).toContain('Either it does not exist, or this credential is not granted it')
    // The remedy, rendered through the gate's own formatter so both surfaces read alike.
    expect(printed).toContain("1. If 'cf-acc-catalog-api' does not exist yet, create it EMPTY")
    expect(printed).toContain("'cf-acc-catalog-api' under 'someone-else'")
    // And the connection's METHOD narrows the access step rather than naming both cases.
    expect(printed).toContain('a GitHub classic PAT needs `repo`')
    expect(printed).not.toContain('If this workspace connects with an app installation')
  })

  it('says a re-check that failed is a re-check, and stops pushing the creation page', async () => {
    // A second failed attempt is a different message from the first: "still not reachable" is the
    // answer to what the operator just did. And the creation page stops being the DEFAULT action,
    // because past one re-check the repository usually exists and re-opening the form cannot help.
    const io = fakeIo({
      secrets: [TOKEN],
      confirms: { 'Re-check': true, 'Open the token page': false },
    })
    let attempts = 0
    const client = fakeClient({
      link: async (_owner, name) => {
        attempts += 1
        // Unreachable twice, then reachable, so the loop runs exactly one re-check before settling.
        return attempts > 2 ? adopted(name) : { status: 'unreachable' }
      },
    })
    await configure({
      io: io.io,
      shell: fakeShell({ 'config view': { code: 0, stdout: 'https://k8s:6443' } }),
      envPath: '/tmp/.env',
      readFile: () => null,
      writeFile: () => {},
      connect: () => client,
    })
    const printed = io.output.join('\n')
    expect(printed).toContain('Re-checked, and acme/cf-acc-catalog-api is STILL not reachable')
    // Offered both times, defaulted to only the first: the fake answers a confirm with its default
    // unless scripted, so exactly one open is the evidence.
    expect(io.opened).toEqual([
      'https://github.com/new?name=cf-acc-catalog-api&owner=acme&visibility=private',
    ])
  })

  it('reports a deployment fault as one, rather than as a repository to go and create', async () => {
    // The three-state rule on the one call that would otherwise blame the operator: an unwired module
    // and a provider outage are both 5xx, and neither is fixed by creating a repository.
    const { outcome, io } = await run({
      client: fakeClient({
        link: async () => {
          throw new Error('503 unavailable: repo_linking_unwired')
        },
      }),
      script: { secrets: [TOKEN] },
    })
    const printed = io.output.join('\n')
    expect(printed).toContain('could not be completed for acme/cf-acc-catalog-api')
    expect(printed).toContain('unknown rather than answered no')
    expect(printed).not.toContain('does not exist yet, create it')
    // And the `.env` is still written: the nine other answers are worth keeping.
    expect(outcome.ok).toBe(true)
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
        available: async () => {
          throw new Error('500 boom')
        },
        link: async () => ({ status: 'unreachable' }),
      }),
      // The owner has to be answered for the flow to reach the reads below it: an unresolvable and
      // unanswered owner is now a refusal in its own right (see the test above). Declining the
      // re-check settles each unreachable repository rather than looping.
      script: {
        secrets: [TOKEN],
        answers: { 'Repository owner': 'acme' },
        confirms: { 'Re-check': false },
      },
    })
    const printed = io.output.join('\n')
    expect(printed).toContain('NOT a verdict that nothing is connected')
    expect(printed).toContain('could not be read (503 unavailable)')
    expect(printed).not.toContain('has no source-control connection')
    // The available read is the one whose failure would otherwise become a claim: "this connection
    // reaches nothing" is what an empty list on a failed read would state.
    expect(printed).toContain('could not be read (500 boom)')
    expect(printed).toContain('what this connection CAN reach is unknown')
  })

  it('withholds a creation link on GitLab rather than linking gitlab.com', async () => {
    // `GET /api/v1/vcs/connection` publishes no instance URL, so the only link this code could
    // build for a self-hosted GitLab is a stranger's server.
    const { io } = await run({
      client: fakeClient({
        connection: async () => ({
          accountLogin: 'acme',
          provider: 'gitlab' as const,
          method: 'pat' as const,
        }),
        link: async () => ({ status: 'unreachable' }),
      }),
      script: { secrets: [TOKEN], confirms: { 'Re-check': false } },
    })
    expect(io.opened).toEqual([])
    expect(io.output.join('\n')).toContain('on your provider')
  })

  it('writes the .env even with a repository still unreachable, and says the gate will refuse', async () => {
    // Nine correct answers are worth keeping. The prerequisite gate names the tenth again with its
    // own remedy, so refusing here would only make the operator retype the rest.
    const { outcome, written, io } = await run({
      client: fakeClient({ link: async () => ({ status: 'unreachable' }) }),
      script: { secrets: [TOKEN], confirms: { 'Re-check': false } },
    })
    expect(outcome.ok).toBe(true)
    expect(written).toContain('ACCEPTANCE_BACKEND_REPO=cf-acc-catalog-api')
    expect(io.output.join('\n')).toContain("'target-repos' prerequisite will refuse")
  })

  it('refuses to write a file with no repository owner in it', async () => {
    // `Io.question` ends with `defaultValue ?? ''`, so an unanswered prompt with nothing stored is an
    // EMPTY owner. Written, that is a `.env` whose repository matches are against `''` and which
    // `resolveConfig` then refuses as unset: the command's whole job, reported as done.
    const { outcome, written, io } = await run({
      client: fakeClient({ connection: async () => null }),
      script: { secrets: [TOKEN] },
    })
    expect(outcome.ok).toBe(false)
    expect(written).toBeNull()
    expect(io.output.join('\n')).toContain('Nothing was written')
  })

  it('reports a repository whose service is homed on ANOTHER board as unusable, not as ready', async () => {
    // `serviceId: null` with `linkedElsewhere: true` is the contract's honest answer for a frame this
    // key cannot address. Reporting only the id would call it visible-and-free and leave the 409 for
    // the pass.
    const { io } = await run({
      client: fakeClient({
        link: async (_owner, name) =>
          name === 'cf-acc-catalog-api'
            ? adopted(name, {
                repo: {
                  owner: 'acme',
                  name,
                  serviceId: null,
                  linkedElsewhere: true,
                  monorepo: false,
                },
              })
            : adopted(name),
      }),
      script: { secrets: [TOKEN] },
    })
    const printed = io.output.join('\n')
    expect(printed).toContain('repo_service_homed_elsewhere')
    expect(printed).not.toContain('cf-acc-catalog-api is adopted by this workspace')
  })
})

// Its own block, and not only for the line budget: every test here is about ONE join (the preset
// library against the model catalog), where the repository tests above are about a write. The
// question they all answer is what a menu may claim about a model nobody can dispatch to, which is
// where every misreport in this command's history has lived.
describe('configure: the model preset', () => {
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
      client: fakeClient({
        models: async () => ({
          models: [{ modelId: 'claude-opus', available: false }],
          excludesUserScopedModels: false,
        }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(answered.io.offered).toEqual([
      'Claude Opus 5 (claude-opus) (no provider wired for it) [workspace default]',
    ])
  })

  it('says a model is INVISIBLE, not unwired, when the ROW says its credential is a person’s', async () => {
    // The misreport this path exists to prevent, and the one that sent an operator here: a
    // workspace whose Claude runs come from a stored personal subscription got "no provider wired
    // for it" against the model it uses every day, and the fix it named (add a provider key) was
    // for a deployment that was already configured correctly.
    //
    // `subscriptionConfigured: null` is the deployment saying it had NOBODY to ask about, which is
    // as far as it can go for a key nobody minted in the app.
    const { io } = await run({
      client: fakeClient({
        models: async () => ({
          models: [
            {
              modelId: 'claude-opus',
              available: false,
              policyBlocked: false,
              personalSubscription: true,
              subscriptionConfigured: null,
            },
          ],
          excludesUserScopedModels: false,
        }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(io.offered).toEqual([
      'Claude Opus 5 (claude-opus) (not visible to this token) [workspace default]',
    ])
    // And the remedy is stated once, in full, rather than left for the operator to infer from a
    // parenthetical: it is a different token, not a different deployment setting.
    expect(io.output.join('\n')).toContain('"Runs as" set to yourself')
  })

  it('says the subscription IS connected when the deployment resolved one for this key’s owner', async () => {
    // The state the whole read exists to reach, and the one an operator previously arrived at only
    // by re-minting the token to see what happened. Whether the credential EXISTS is a row lookup,
    // so the deployment can answer it without the personal password that would OPEN it, and the
    // answer turns a diagnosis ("this cannot be judged") into an instruction ("mint it bound").
    const { io } = await run({
      client: fakeClient({
        models: async () => ({
          models: [
            {
              modelId: 'claude-opus',
              available: false,
              policyBlocked: false,
              personalSubscription: true,
              subscriptionConfigured: true,
            },
          ],
          excludesUserScopedModels: false,
        }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(io.offered).toEqual([
      'Claude Opus 5 (claude-opus) (your subscription is connected; this token is not bound to ' +
        'spend it) [workspace default]',
    ])
    const said = io.output.join('\n')
    expect(said).toContain('Nothing is missing from the deployment')
    expect(said).toContain('"Runs as" set to yourself')
  })

  it('does not claim a subscription that the deployment looked for and did not find', async () => {
    // `false` is an ANSWER, not the absence of one: the owner is known and holds nothing for this
    // vendor, so re-minting the token bound would change nothing and the remedy is a credential.
    const { io } = await run({
      client: fakeClient({
        models: async () => ({
          models: [
            {
              modelId: 'claude-opus',
              available: false,
              policyBlocked: false,
              personalSubscription: true,
              subscriptionConfigured: false,
            },
          ],
          excludesUserScopedModels: false,
        }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(io.offered).toEqual([
      'Claude Opus 5 (claude-opus) (runs on a personal subscription; this token’s owner has none) ' +
        '[workspace default]',
    ])
    expect(io.output.join('\n')).not.toContain('Nothing is missing from the deployment')
  })

  it('still calls a genuinely unwired model unwired, on a deployment that withholds others', async () => {
    // The opposite misreport, and the reason the label is read off the ROW: a per-RESPONSE flag is
    // true of any deployment that COULD hold a personal subscription, so deriving the label from it
    // told an operator to re-mint their token for a model whose provider key was simply never
    // added. Re-minting would change nothing.
    const { io } = await run({
      client: fakeClient({
        models: async () => ({
          models: [
            {
              modelId: 'claude-opus',
              available: false,
              policyBlocked: false,
              personalSubscription: false,
              subscriptionConfigured: null,
            },
          ],
          excludesUserScopedModels: true,
        }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(io.offered).toEqual([
      'Claude Opus 5 (claude-opus) (no provider wired for it) [workspace default]',
    ])
  })

  it('keeps an UNJUDGED workspace default selected rather than steering to another model', async () => {
    // Preselecting the "selectable" one would run the whole pass on a model nobody chose, in
    // exactly the case the warning above has just told the operator to expect. An unjudged default
    // costs at worst one refusal at start, which names the token as the problem and can be fixed by
    // re-minting it; a silent switch to Kimi is a green pass that proved the wrong thing.
    //
    // UNJUDGED specifically: the deployment resolved nobody, so the subscription may well be there.
    // The sibling below pins the opposite disposition for the case it answered.
    const { written } = await run({
      client: fakeClient({
        models: async () => ({
          models: [
            {
              modelId: 'claude-opus',
              available: false,
              policyBlocked: false,
              personalSubscription: true,
              subscriptionConfigured: null,
            },
            {
              modelId: 'kimi-k2',
              available: true,
              policyBlocked: false,
              personalSubscription: false,
              subscriptionConfigured: null,
            },
          ],
          excludesUserScopedModels: false,
        }),
        presets: async () => [
          {
            presetId: 'mdp_claude',
            name: 'Claude Opus 5',
            baseModelId: 'claude-opus',
            isDefault: true,
          },
          { presetId: 'mdp_kimi', name: 'Kimi', baseModelId: 'kimi-k2', isDefault: false },
        ],
      }),
      script: { secrets: [TOKEN] },
    })
    expect(written).toContain('ACCEPTANCE_MODEL_PRESET=mdp_claude')
  })

  it('steers off a default the deployment ANSWERED has no subscription behind it', async () => {
    // The line between the two dispositions. `null` is worth waiting on, because re-minting the
    // token might resolve a person who holds one. `false` is the deployment saying it resolved the
    // person and they hold none, so keeping the default selected buys a CERTAIN refusal at the
    // first dispatch over a preset that runs. Identical fixture to the sibling above but for that
    // one field, which is the whole point: the two states must not share a disposition.
    const { written } = await run({
      client: fakeClient({
        models: async () => ({
          models: [
            {
              modelId: 'claude-opus',
              available: false,
              policyBlocked: false,
              personalSubscription: true,
              subscriptionConfigured: false,
            },
            {
              modelId: 'kimi-k2',
              available: true,
              policyBlocked: false,
              personalSubscription: false,
              subscriptionConfigured: null,
            },
          ],
          excludesUserScopedModels: false,
        }),
        presets: async () => [
          {
            presetId: 'mdp_claude',
            name: 'Claude Opus 5',
            baseModelId: 'claude-opus',
            isDefault: true,
          },
          { presetId: 'mdp_kimi', name: 'Kimi', baseModelId: 'kimi-k2', isDefault: false },
        ],
      }),
      script: { secrets: [TOKEN] },
    })
    expect(written).toContain('ACCEPTANCE_MODEL_PRESET=mdp_kimi')
  })

  it('marks a POLICY-refused model as refused, not as one belonging to a person', async () => {
    // The cause no credential can undo, and the one the join used to miss entirely: a row the
    // account's model-family policy refuses was ranked by its subscription fields, so a model with
    // a live subscription behind it read as "your subscription is connected; this token is not
    // bound to spend it" and told the operator nothing was missing from the deployment. Both
    // claims are false, and the policy is what has to change.
    const { io } = await run({
      client: fakeClient({
        models: async () => ({
          models: [
            {
              modelId: 'claude-opus',
              available: false,
              policyBlocked: true,
              personalSubscription: true,
              subscriptionConfigured: true,
            },
          ],
          excludesUserScopedModels: false,
        }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(io.offered).toEqual([
      'Claude Opus 5 (claude-opus) (configured, and refused by the account’s model-family policy) ' +
        '[workspace default]',
    ])
    expect(io.output.join('\n')).not.toContain('Nothing is missing from the deployment')
  })

  it('preselects a preset whose model is wired over the workspace default that is not', async () => {
    const { written, io } = await run({
      client: fakeClient({
        presets: async () => [
          { presetId: 'mdp_claude', name: 'Claude', baseModelId: 'claude-opus', isDefault: true },
          { presetId: 'mdp_kimi', name: 'Kimi', baseModelId: 'kimi', isDefault: false },
        ],
        models: async () => ({
          models: [
            {
              modelId: 'claude-opus',
              available: false,
              policyBlocked: false,
              personalSubscription: false,
              subscriptionConfigured: null,
            },
            {
              modelId: 'kimi',
              available: true,
              policyBlocked: false,
              personalSubscription: false,
              subscriptionConfigured: null,
            },
          ],
          excludesUserScopedModels: false,
        }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(written).toContain('ACCEPTANCE_MODEL_PRESET=mdp_kimi')
    expect(io.prompted.join('\n')).toContain('Model preset')
  })
})

// The reporter token, which is the one credential this command can neither resolve nor mint, and the
// one whose page it CAN prefill.
describe('configure: the reporter token', () => {
  it('opens a prefilled minting page and names the narrower credential it cannot prefill', async () => {
    const { written, io } = await run({ script: { secrets: [TOKEN] } })
    expect(io.opened).toContain(
      'https://github.com/settings/tokens/new?description=cat-factory+acceptance+%28acme%2Fcf-acc-catalog-api%29&scopes=repo',
    )
    const printed = io.output.join('\n')
    // Both halves: the classic form is what can be prefilled, and a fine-grained token is the better
    // thing to hold, so the operator is told which is which rather than having one chosen for them.
    expect(printed).toContain('Issues: Read and write')
    expect(printed).toContain('prefilled')
    expect(written).toContain('ACCEPTANCE_VCS_TOKEN=ghp_reporter_value')
  })

  it('says why the workspace’s own connection cannot be reused for it', async () => {
    // The reason is the whole design of spec 04, and an operator who does not know it will paste the
    // API token or the App's credential here and get a test that proves nothing.
    const { io } = await run({ script: { secrets: [TOKEN] } })
    expect(io.output.join('\n')).toContain('circular')
  })

  it('never prints the token back, and keeps a stored one without asking again', async () => {
    const { written, io } = await run({
      existing: 'ACCEPTANCE_VCS_TOKEN=already-minted\n',
      script: { secrets: [TOKEN], confirms: { 'Replace the stored reporter token': false } },
    })
    expect(written).toContain('ACCEPTANCE_VCS_TOKEN=already-minted')
    const printed = io.output.join('\n')
    expect(printed).toContain('ACCEPTANCE_VCS_TOKEN=(set, not shown)')
    expect(printed).not.toContain('already-minted')
  })

  it('asks for a paste with instructions when no minting page can be built', async () => {
    // A provider whose instance is unknowable gets the same treatment its repository link gets: the
    // affordance is withheld and the steps stand on their own.
    const { io } = await run({
      client: fakeClient({
        connection: async () => ({
          accountLogin: 'acme',
          provider: 'gitlab' as const,
          method: 'pat' as const,
        }),
      }),
      script: { secrets: [TOKEN] },
    })
    expect(io.opened.join('\n')).not.toContain('tokens/new')
    expect(io.output.join('\n')).toContain('ACCEPTANCE_VCS_API_BASE')
  })
})

// The cluster pair, whose rule is the opposite of every other value here: the STORED one wins over
// what the kubeconfig currently says.
describe('configure: the cluster', () => {
  it('normalizes the wildcard bind address k3d writes into the kubeconfig', async () => {
    // `cat-factory k3s` pipes the same read through `normalizeApiServerUrl` because `0.0.0.0` is not
    // dialable; writing it unchanged fails `cluster-connection` against an address nothing listens on.
    const { written } = await run({
      script: { secrets: [TOKEN] },
      shell: {
        'config view': { code: 0, stdout: 'https://0.0.0.0:6443\n' },
        'get secret': { code: 0, stdout: Buffer.from('cluster-token').toString('base64') },
      },
    })
    expect(written).toContain('ACCEPTANCE_K3S_API_SERVER=https://127.0.0.1:6443\n')
    expect(written).not.toContain('0.0.0.0')
  })

  it('keeps the stored apiserver when kubectl points somewhere else, and says so', async () => {
    // A kubectl context is a passing state; this file is the pass's configuration. Letting the
    // context win would silently re-point the cluster on a re-run to fix a repository name.
    const { written, io } = await run({
      existing: 'ACCEPTANCE_K3S_API_SERVER=https://acceptance:6443\nACCEPTANCE_K3S_TOKEN=stored\n',
      script: { secrets: [TOKEN] },
      shell: {
        'config view': { code: 0, stdout: 'https://elsewhere:6443' },
        'get secret': { code: 0, stdout: Buffer.from('other-cluster-token').toString('base64') },
      },
    })
    expect(written).toContain('ACCEPTANCE_K3S_API_SERVER=https://acceptance:6443')
    // And the token is NOT taken from that context: cluster A's URL beside cluster B's bearer token
    // fails as a 401, which is indistinguishable from the RBAC problem the warning describes.
    expect(written).toContain('ACCEPTANCE_K3S_TOKEN=stored')
    expect(written).not.toContain('other-cluster-token')
    expect(io.output.join('\n')).toContain('NOT the current kubeconfig context')
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
    expect(io.output.join('\n')).toContain(
      'The current kubeconfig context serves https://127.0.0.1:6443',
    )
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

  it('re-writes the carried-over header instead of stacking one copy per run', () => {
    // The header introduces UNMANAGED content, so the ordinary comment-block rule carries it over,
    // and a merge that then prepended a fresh copy grew the file by one identical line every run.
    // A single merge cannot see this, which is why it is asserted across three.
    let text: string | null = 'ACCEPTANCE_RUN_BUDGET_MS=1200000\n# my own note\n'
    for (let pass = 0; pass < 3; pass++) {
      text = mergeEnvFile(text, [{ key: 'A', value: '1', comment: ['managed'] }]).text
    }
    expect(text?.match(/Carried over unchanged/g)).toHaveLength(1)
    expect(text).toContain('ACCEPTANCE_RUN_BUDGET_MS=1200000')
    expect(text).toContain('# my own note')
  })

  it('quotes a managed value the reader would otherwise disagree about', () => {
    // The suite reads its `.env` with `node:util`'s `parseEnv`, which treats an unquoted `#` as a
    // comment and strips surrounding whitespace, while `renderEnvFile` emits a bare `KEY=value`. So a
    // value READ from a quoted line, offered as a default and accepted unchanged was written back as
    // a DIFFERENT value, with `describeMerge` calling it unchanged.
    const merge = mergeEnvFile('ACCEPTANCE_NAME_PREFIX="cf-acc #2"\n', [
      { key: 'ACCEPTANCE_NAME_PREFIX', value: 'cf-acc #2' },
    ])
    expect(merge.kept).toEqual(['ACCEPTANCE_NAME_PREFIX'])
    expect(merge.text).toBe('ACCEPTANCE_NAME_PREFIX="cf-acc #2"\n')
    expect(parseEnv(merge.text).ACCEPTANCE_NAME_PREFIX).toBe('cf-acc #2')
  })

  it('round-trips every ordinary managed value through parseEnv unchanged', () => {
    // The property that matters is agreement between this writer and the suite's reader, asserted
    // over the value shapes that actually occur rather than over one hand-picked string.
    const values = ['http://127.0.0.1:8787', 'cf_live_pak_a.b-c', 'ws_1', 'cf-acc', 'true', '']
    for (const value of values) {
      const text = mergeEnvFile(null, [{ key: 'K', value }]).text
      expect(parseEnv(text).K ?? '').toBe(value)
    }
  })

  it('refuses a value no quoting style can represent, rather than writing a lie', () => {
    // `parseEnv` supports both delimiters and no escape inside either, so a value carrying both quote
    // characters cannot survive. This command's promise is that the file it wrote is the file the
    // suite will read.
    expect(() => mergeEnvFile(null, [{ key: 'K', value: `he said "hi" to 'them'` }])).toThrow(
      /cannot be written to a .env file/,
    )
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
    expect([...SECRET_KEYS].sort()).toEqual([
      'ACCEPTANCE_K3S_TOKEN',
      'ACCEPTANCE_VCS_TOKEN',
      'CAT_FACTORY_API_KEY',
    ])
  })
})
