// The DIRECTORY tag's operation docs and the OpenAPI 3.1 `webhooks` entry for the directory push
// (backend/docs/adr/0067-directory-sync.md). generate-openapi.mjs spreads both in; they live here so
// that file stays inside its size budget.

/** Operation docs for `/api/v1/directory/*`, keyed by operationId like `OPERATION_DOCS`. */
export const DIRECTORY_OPERATION_DOCS = {
  listDirectoryChanges: {
    tag: 'Directory',
    summary: 'List directory changes',
    description:
      'The account’s directory changes after `after`, in `seq` order, each carrying the CURRENT state of the entity it names, or `null` once that entity no longer exists or is outside the key’s reach. Store `nextAfter` and pass it back as `after`; it can move past the last change served, since changes the key cannot see are skipped. `nextAfter === headSeq` means caught up. A cursor whose following changes were pruned (see `DIRECTORY_CHANGE_RETENTION_DAYS`), or one ahead of the feed, is refused with `409` and `reason: "cursor_expired"`: reconcile from the snapshot endpoints and replay from their `asOfSeq`. Account-scoped: no `x-cat-factory-workspace` header is read. A key limited to some workspaces sees only workspace, workspace-membership and repository changes of those workspaces.',
  },
  listDirectoryWorkspaces: {
    tag: 'Directory',
    summary: "List the account's workspaces",
    description:
      'A keyset-paged snapshot of the account’s workspaces (the ones the key reaches). Every page of one walk reports the same `asOfSeq`; after the last page, replay the change feed from it to pick up anything that changed while paging.',
  },
  listDirectoryUsers: {
    tag: 'Directory',
    summary: "List the account's users",
    description:
      'A keyset-paged snapshot of every user holding a membership in the account. Account-wide, so a key limited to some workspaces is refused with `403` and `reason: "account_scope_required"`.',
  },
  listDirectoryAccountMemberships: {
    tag: 'Directory',
    summary: "List the account's memberships",
    description:
      'A keyset-paged snapshot of the account’s memberships, each with the member’s account roles. Account-wide, so a key limited to some workspaces is refused with `403` and `reason: "account_scope_required"`.',
  },
  listDirectoryWorkspaceMemberships: {
    tag: 'Directory',
    summary: 'List workspace memberships',
    description:
      'A keyset-paged snapshot of the explicit workspace memberships in the account’s workspaces (the ones the key reaches), each with its workspace role.',
  },
  listDirectoryRepos: {
    tag: 'Directory',
    summary: 'List linked repositories',
    description:
      'A keyset-paged snapshot of the repositories linked to the account’s workspaces (the ones the key reaches). A repository is listed once per workspace that links it.',
  },
  listDirectoryWebhooks: {
    tag: 'Directory',
    summary: "List the account's directory webhooks",
    description:
      'The endpoints the directory change feed is pushed to, each with the feed position delivered through. The signing secret is write-only: `hasSecret` says whether one is set. Requires an `admin` key that reaches every workspace (`403` with `reason: "account_scope_required"` otherwise), because an endpoint receives every change in the account.',
  },
  putDirectoryWebhook: {
    tag: 'Directory',
    summary: 'Register or edit a directory webhook',
    description:
      'Register an endpoint the directory change feed is pushed to, or edit one; an omitted field keeps its stored value, and `url` is required only when registering. A new endpoint starts at the feed head: it is pushed what changes from now on, and its receiver bootstraps the past from the snapshots. Pushes run every couple of minutes, signed like the notification webhooks, each a `DirectoryWebhookDelivery`. An account holds at most 10 (`409` with `reason: "webhook_limit_reached"`).',
  },
  deleteDirectoryWebhook: {
    tag: 'Directory',
    summary: 'Remove a directory webhook',
    description: 'Stop pushing to an endpoint. Idempotent.',
  },
}
