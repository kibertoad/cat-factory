import type { WorkRunner } from '@cat-factory/core'

/** Records WorkRunner calls so tests can assert the engine signals correctly. */
export class FakeWorkRunner implements WorkRunner {
  readonly started: { workspaceId: string; executionId: string }[] = []
  readonly signalled: {
    workspaceId: string
    executionId: string
    decisionId: string
    choice: string
  }[] = []
  readonly cancelled: { workspaceId: string; executionId: string }[] = []

  async startRun(workspaceId: string, executionId: string): Promise<void> {
    this.started.push({ workspaceId, executionId })
  }

  async signalDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<void> {
    this.signalled.push({ workspaceId, executionId, decisionId, choice })
  }

  async cancelRun(workspaceId: string, executionId: string): Promise<void> {
    this.cancelled.push({ workspaceId, executionId })
  }
}

/** Agent executor that always throws — exercises the retry/rethrow path. */
export class ThrowingAgentExecutor {
  constructor(private readonly message = 'boom') {}
  async run(): Promise<never> {
    throw new Error(this.message)
  }
}
