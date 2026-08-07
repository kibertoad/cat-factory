---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
---

Bring the document and task source integrations to a mothership-mode node

Every other connection surface reached mothership mode long ago: environments, observability,
Slack, runner pools all store their credential as a sealed blob, so only ciphertext crosses the
persistence RPC and the mothership opens it on request. The document-source and tracker connections
were the last two outside that, and the reason was mechanical rather than a judgement about how
sensitive a Figma or Jira token is. Their repositories decrypted INSIDE, which shuts both doors at
once: a repository that decrypts can only be called by a key-holder, so proxying its read would have
put a plaintext token on the wire, and it exposes no sealed field, so `/internal/secrets/unseal` had
nothing to name either. That is why the prerequisite was always "give those repositories a
sealed-blob read first, and only then a source-table entry".

The row now carries its envelope. `DocumentConnectionRecord` and `TaskConnectionRecord` split into a
stored `Sealed*Record` the repository persists and an open record the services read, with a new
kernel port pair (`DocumentConnectionStore` / `TaskConnectionStore`) as the seam and one shared
implementation over `createOrgSecretCipher`. All four repositories (D1 and Drizzle, documents and
tasks) stopped decrypting and became ordinary sealed-blob stores.

With that in place, `document_source_connection` and `task_source_connection` join the closed
org-secret table, keyed by `(workspace, source)` under their own HKDF domains, and the persistence
allow-list widens to the whole of both integrations: the connection repositories and the
per-workspace source toggle, the document import/link writes and the role-link surface, and the task
import/link writes including the atomic claim that holds one-task-per-ticket. Batched forms move
with their point siblings rather than behind them, since `linkBlockMany`/`detachBlocks` are the same
write as `linkBlock` and a claim whose import cannot land claims nothing.

The store's surface is deliberately split by how much a caller needs opened rather than how much it
reads. Listing summaries opens nothing, because a settings panel renders labels and opening a bag
per connected source would turn one page load into a burst of unseal round trips and fail the whole
list on the first unopenable row. Connecting and disconnecting read the summary for the same reason
from the other direction: replacing or removing a connection is the remedy for a bag that has gone
bad, so neither may be the call that needs the key.

Dispatch-time document freshness now runs on a mothership-mode node. Its `credentials_unreadable`
verdict stays a distinct gap and is worth more than it was: it no longer means "this deployment
structurally cannot read the credentials" on every dispatch of every run, so its remaining causes are
real faults. Its log line went back to `warn` accordingly.

How many row identifiers a delegated unseal must carry is now declared once, in kernel's
`ORG_SECRET_KEY_ARITY`, and enforced by the type system. It previously lived only in the server-side
bindings table, which is the one part of a binding a caller has to get right and the one table a
caller in `@cat-factory/integrations` cannot see. `DelegatedSecretRef` became a union over the source
vocabulary, so a literal is checked against its own source's arity, and `orgSecretRef` is the door
for a generic caller that never names a member. This matters more than it reads: a deployment with no
delegate wired ignores the reference entirely, so a malformed one is invisible everywhere except the
single deployment shape that delegates.

Two behaviour changes worth knowing about. A credential bag that cannot be opened now raises instead
of resolving to an empty bag, because an empty bag is indistinguishable from a connection saved with
no credentials and every caller was re-deriving the difference from whatever the vendor said next. It
raises a 503 carrying `reason: 'connection_credentials_unreadable'`, so the surfaces that genuinely
cannot proceed refuse with translated copy rather than a generic server error. And the legacy
plaintext `credentials` column fallback is gone: a row written before these tables were encrypted at
all is no longer read as JSON and re-encrypted on the next write, so re-connect the affected source.
Pre-1.0 internals break rather than grow a compatibility path, and keeping the fallback would have
meant the unseal endpoint answering for a field that is sometimes not an envelope.

Raising rather than emptying puts weight on WHO raises and to whom, so the failure is scoped to what
actually failed. A batched open answers per source: the sources in one call are independent facts
about independent vendors, and one rejection speaking for all of them would report a run's whole
document corpus as unreadable because a single shelf entry drifted, or take the reply channel away
from a healthy ticket because a different tracker's envelope went bad. Both read to an operator as
the healthy sources being broken. A corpus-wide verdict is now reachable only when the stored-row
query itself failed, where nothing about any source was learned.

For the same reason, a surface whose job is to REPAIR an unopenable connection is not allowed to be a
surface that needs the key. Re-connecting a tracker reads the old bag only to carry the
platform-owned webhook secret across a vendor-credential rotation; refusing on that read left a
workspace with no way out of a bad row at all, so it now degrades and says so, and the operator mints
a fresh secret. Sealing rides the same delegation as opening, which is what keeps that from being a
silent loss on a transient fault: a node that cannot reach its key service fails the write too, so
nothing is overwritten. The setup check reports the fault as a verdict instead of failing, and the
read-only webhook panel states it as a new `credentialsReadable: false` rather than reporting
`configured: false`, which would send an operator to mint a secret over a bag that still holds the
live one. Clearing the webhook secret still refuses, because clearing rewrites the bag minus a key
and proceeding blind would replace the vendor credentials with an empty object.
