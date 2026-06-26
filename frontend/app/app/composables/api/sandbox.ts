import type {
  CloneSandboxPromptInput,
  CreateSandboxExperimentInput,
  SandboxExperiment,
  SandboxExperimentDetail,
  SandboxFixture,
  SandboxOverview,
  SandboxPromptVersion,
  SaveSandboxVersionInput,
} from '~/types/sandbox'
import type { ApiContext } from './context'

/**
 * The Sandbox API (the parallel prompt/model testing surface): manage versioned prompt
 * candidates + the fixture library, define experiments (prompt × model × fixture), and
 * launch one to run + grade every cell. Opt-in: every endpoint 503s when the deployment
 * hasn't wired the Sandbox (its dedicated DB / schema).
 */
export function sandboxApi({ http, ws }: ApiContext) {
  const base = (workspaceId: string) => `${ws(workspaceId)}/sandbox`
  return {
    getSandboxOverview: (workspaceId: string) =>
      http<SandboxOverview>(`${base(workspaceId)}/overview`),

    // ---- prompt versions -------------------------------------------------
    cloneSandboxPrompt: (workspaceId: string, body: CloneSandboxPromptInput) =>
      http<SandboxPromptVersion>(`${base(workspaceId)}/prompts/clone`, { method: 'POST', body }),
    saveSandboxVersion: (workspaceId: string, body: SaveSandboxVersionInput) =>
      http<SandboxPromptVersion>(`${base(workspaceId)}/prompts`, { method: 'POST', body }),
    setSandboxPromptLabels: (workspaceId: string, promptId: string, labels: string[]) =>
      http<SandboxPromptVersion>(
        `${base(workspaceId)}/prompts/${encodeURIComponent(promptId)}/labels`,
        { method: 'PATCH', body: { labels } },
      ),
    archiveSandboxPrompt: (workspaceId: string, promptId: string) =>
      http(`${base(workspaceId)}/prompts/${encodeURIComponent(promptId)}`, { method: 'DELETE' }),

    // ---- fixtures --------------------------------------------------------
    createSandboxFixture: (workspaceId: string, body: Partial<SandboxFixture>) =>
      http<SandboxFixture>(`${base(workspaceId)}/fixtures`, { method: 'POST', body }),
    deleteSandboxFixture: (workspaceId: string, fixtureId: string) =>
      http(`${base(workspaceId)}/fixtures/${encodeURIComponent(fixtureId)}`, { method: 'DELETE' }),

    // ---- experiments -----------------------------------------------------
    createSandboxExperiment: (workspaceId: string, body: CreateSandboxExperimentInput) =>
      http<SandboxExperiment>(`${base(workspaceId)}/experiments`, { method: 'POST', body }),
    getSandboxExperiment: (workspaceId: string, experimentId: string) =>
      http<SandboxExperimentDetail>(
        `${base(workspaceId)}/experiments/${encodeURIComponent(experimentId)}`,
      ),
    launchSandboxExperiment: (workspaceId: string, experimentId: string) =>
      http<SandboxExperimentDetail>(
        `${base(workspaceId)}/experiments/${encodeURIComponent(experimentId)}/launch`,
        { method: 'POST' },
      ),
  }
}
