import {
  archiveSandboxPromptContract,
  cloneSandboxPromptContract,
  createSandboxExperimentContract,
  createSandboxFixtureContract,
  getSandboxExperimentContract,
  launchSandboxExperimentContract,
  removeSandboxFixtureContract,
  sandboxOverviewContract,
  saveSandboxPromptContract,
  setSandboxPromptLabelsContract,
} from '@cat-factory/contracts'
import type { SendParams } from './client'
import type { ApiContext } from './context'

// Request bodies are typed from the contract's INPUT shape (`SendParams[...]['body']`),
// so valibot-defaulted fields (labels / repeats / budgetTokens) stay optional for callers —
// the contract's exported `*Input` types are the post-default OUTPUT shape and would force
// callers to supply them.
type CloneSandboxPromptBody = NonNullable<SendParams<typeof cloneSandboxPromptContract>['body']>
type SaveSandboxVersionBody = NonNullable<SendParams<typeof saveSandboxPromptContract>['body']>
type CreateSandboxFixtureBody = NonNullable<SendParams<typeof createSandboxFixtureContract>['body']>
type CreateSandboxExperimentBody = NonNullable<
  SendParams<typeof createSandboxExperimentContract>['body']
>

/**
 * The Sandbox API (the parallel prompt/model testing surface): manage versioned prompt
 * candidates + the fixture library, define experiments (prompt × model × fixture), and
 * launch one to run + grade every cell. Opt-in: every endpoint 503s when the deployment
 * hasn't wired the Sandbox (its dedicated DB / schema).
 */
export function sandboxApi({ send, ws }: ApiContext) {
  return {
    getSandboxOverview: (workspaceId: string) =>
      send(sandboxOverviewContract, { pathPrefix: ws(workspaceId) }),

    // ---- prompt versions -------------------------------------------------
    cloneSandboxPrompt: (workspaceId: string, body: CloneSandboxPromptBody) =>
      send(cloneSandboxPromptContract, { pathPrefix: ws(workspaceId), body }),
    saveSandboxVersion: (workspaceId: string, body: SaveSandboxVersionBody) =>
      send(saveSandboxPromptContract, { pathPrefix: ws(workspaceId), body }),
    setSandboxPromptLabels: (workspaceId: string, promptId: string, labels: string[]) =>
      send(setSandboxPromptLabelsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { promptId },
        body: { labels },
      }),
    archiveSandboxPrompt: (workspaceId: string, promptId: string) =>
      send(archiveSandboxPromptContract, { pathPrefix: ws(workspaceId), pathParams: { promptId } }),

    // ---- fixtures --------------------------------------------------------
    createSandboxFixture: (workspaceId: string, body: CreateSandboxFixtureBody) =>
      send(createSandboxFixtureContract, { pathPrefix: ws(workspaceId), body }),
    deleteSandboxFixture: (workspaceId: string, fixtureId: string) =>
      send(removeSandboxFixtureContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { fixtureId },
      }),

    // ---- experiments -----------------------------------------------------
    createSandboxExperiment: (workspaceId: string, body: CreateSandboxExperimentBody) =>
      send(createSandboxExperimentContract, { pathPrefix: ws(workspaceId), body }),
    getSandboxExperiment: (workspaceId: string, experimentId: string) =>
      send(getSandboxExperimentContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { experimentId },
      }),
    launchSandboxExperiment: (workspaceId: string, experimentId: string) =>
      send(launchSandboxExperimentContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { experimentId },
      }),
  }
}
