---
'@cat-factory/kernel': minor
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

Two behaviour changes worth knowing about. A credential bag that cannot be opened now raises instead
of resolving to an empty bag, because an empty bag is indistinguishable from a connection saved with
no credentials and every caller was re-deriving the difference from whatever the vendor said next.
And the legacy plaintext `credentials` column fallback is gone: a row written before these tables
were encrypted at all is no longer read as JSON and re-encrypted on the next write, so re-connect the
affected source. Pre-1.0 internals break rather than grow a compatibility path, and keeping the
fallback would have meant the unseal endpoint answering for a field that is sometimes not an
envelope.
