// Sensitive per-service test-secret shapes (SEALED, write-only). A Tester needs these
// to exercise a third-party integration (e.g. a Stripe API key). Sealed at rest on the
// backend and injected into the Tester container OUT OF BAND — never rendered into a
// prompt or the telemetry snapshot. The view returns only the configured keys +
// descriptions (`TestSecretRef`); values are write-only and never read back.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).
// See docs/initiatives/tester-environment-access.md (Slice C).

export type {
  TestSecretRef,
  TestSecretEntry,
  ServiceTestSecretsView,
  UpsertServiceTestSecretsInput,
} from '@cat-factory/contracts'
