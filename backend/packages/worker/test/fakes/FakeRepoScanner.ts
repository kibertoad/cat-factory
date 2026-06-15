import type { RepoScanner, ScanRepoRequest, ScannedBlueprint } from '@cat-factory/core'

/**
 * Deterministic RepoScanner for integration tests: records each request and
 * returns a canned blueprint (or throws when `failWith` is set), so the board-scan
 * orchestration can be exercised without GitHub or a real container. By default it
 * derives a small service → modules → features tree from the requested repo name.
 */
export class FakeRepoScanner implements RepoScanner {
  readonly calls: ScanRepoRequest[] = []
  /** When set, `scan` throws with this message to exercise the failure path. */
  failWith: string | null = null
  /** When set, returned verbatim instead of the derived default. */
  result: ScannedBlueprint | null = null

  async scan(request: ScanRepoRequest): Promise<ScannedBlueprint> {
    this.calls.push(request)
    if (this.failWith) throw new Error(this.failWith)
    if (this.result) return this.result
    return {
      source: 'llm',
      service: {
        type: 'service',
        name: request.repo.name,
        summary: `Scanned ${request.repo.owner}/${request.repo.name}.`,
        references: ['package.json', 'src/index.ts'],
        modules: [
          {
            name: 'Auth',
            summary: 'Authentication and sessions.',
            references: ['src/auth'],
            features: [
              {
                title: 'Login endpoint',
                summary: 'Issues a session.',
                references: ['src/auth/login.ts'],
              },
              {
                title: 'Token refresh',
                summary: 'Refreshes an expiring session.',
                references: ['src/auth/refresh.ts'],
              },
            ],
          },
          {
            name: 'Billing',
            summary: 'Invoicing and payments.',
            references: ['src/billing'],
            features: [
              {
                title: 'Create invoice',
                summary: 'Creates a draft invoice.',
                references: ['src/billing/invoice.ts'],
              },
            ],
          },
        ],
      },
    }
  }
}
