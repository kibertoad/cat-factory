/** Issue a request against the facade under test (the harness `call`, narrowed to what we need). */
type SeedCall = (method: string, path: string) => Promise<unknown>

/** What every facade harness's `createWorkspace` accepts. */
export type CreateWorkspaceOptions = {
  name?: string
  /** Seed the demo board + built-in pipelines (the `POST /workspaces` default). */
  seed?: boolean
} & MergePresetSeedOptions

/** The merge-preset half of those options, on its own so the helper below can take just them. */
export interface MergePresetSeedOptions {
  /**
   * Seed the built-in merge-preset library after creating the workspace. Defaults to TRUE; pass
   * `false` only for a case whose subject IS the unconfigured posture (see
   * {@link seedMergePresets}).
   */
  mergePresets?: boolean
}

/**
 * Seed a just-created workspace's built-in MERGE PRESET library, the way loading its board does
 * in production, and return the snapshot so a harness can `return seedMergePresets(...)`.
 *
 * `RiskPolicyService` seeds the catalog lazily, on the first `list()` — and the workspace snapshot
 * the SPA fetches on every board load performs exactly that read. So a workspace anyone has looked
 * at owns a `Balanced` default row, and that is the state every execution assertion in these
 * suites means to be in.
 *
 * A harness that creates a workspace over `POST /workspaces` and immediately starts a run is NOT
 * in that state: nothing has listed the presets, so `getDefault` answers null and the run resolves
 * `FALLBACK_RISK_POLICY`, which auto-merges nothing. That fallback is the correct posture for a
 * deployment that has configured no merge policy, and it is the wrong fixture for a suite whose
 * subject is something else entirely — the run would park on a `merge_review` card for a reason
 * the test never mentions.
 *
 * Hence one shared helper rather than a `GET` sprinkled through the suites: every facade harness
 * routes `createWorkspace` through it, so the fixture cannot drift between runtimes, and a suite
 * that genuinely wants the unconfigured posture passes `mergePresets: false` and says why.
 */
export async function seedMergePresets<T extends { workspace: { id: string } }>(
  call: SeedCall,
  options: MergePresetSeedOptions,
  snapshot: T,
): Promise<T> {
  if (options.mergePresets ?? true) {
    await call('GET', `/workspaces/${snapshot.workspace.id}/risk-policies`)
  }
  return snapshot
}
