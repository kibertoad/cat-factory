---
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/worker': minor
'@cat-factory/conformance': minor
---

Let a mothership open the org credentials a mothership-mode node holds no key for

Mothership mode splits the encryption keys on purpose: a laptop seals its own agent and model
credentials under a local key, and the mothership's `ENCRYPTION_KEY` never travels. That split is
what made every sealed-blob repository safe to serve over the persistence RPC, and it is also what
left those blobs unreadable on the node. A row a hosted teammate wrote is sealed under the
mothership's key, so a mothership-mode node could save an infrastructure connection and never
provision with it, save a Datadog connection and never probe with it, and four earlier slices parked
a surface rather than ship it broken.

`POST /internal/secrets/unseal` and `POST /internal/secrets/seal` close that. The node names the
ROW, never the ciphertext: it posts a source from a closed table plus the row's identifiers, and the
mothership re-reads the authoritative row from its own store, binds the workspace to an account
exactly as the persistence RPC does, and decrypts under its own key. A compromised node token can
therefore only ask for a value it could already have read had it held the key, in an account it can
already reach, which is what keeps this from being a decryption oracle. The seal direction matters
just as much: a mothership-mode node provisions environments, and a row it sealed locally would be
unopenable by the mothership's own teardown with nothing saying so until a reclaim failed.

Consumers reach it through one kernel seam, `createOrgSecretCipher`. With no delegate wired (every
hosted deployment, and local mode over its own Postgres) it is a pass-through to the facade's own
cipher, so nothing changes there.

With provisioning writes now safe to persist, `environmentRegistryRepository.insert`/`update` join
the persistence allow-list, and so does `softDelete`, the tombstone half every re-provision and
every reclaim runs. A mothership-mode node therefore provisions, polls and tears down environments
for real, and the ephemeral-environment self-test runs end to end. Provisioning and teardown take
the delegate together rather than separately: teardown opens the very provision fields provisioning
sealed, so a node holding one and not the other could stand infrastructure up and never reclaim it.

A mothership-mode node may not itself answer the delegation endpoints. They are wired only where a
facade holds its own main database, because a node's `ENCRYPTION_KEY` is the local key that seals
its own agent credentials, and sealing an org row under it is the split this change removes.

Behaviour change worth knowing about on an existing mothership-mode node: rows it previously sealed
under its LOCAL key are no longer opened locally. Pre-1.0 internals break rather than grow a
compatibility path, so re-save an affected environment or observability connection; the key-drift
sweep reports them.

Deliberately still off, and stated in the tracker: the document/task source connections (their
repositories decrypt inside, so there is no sealed field for a row-addressed unseal to name), the
mothership-side Slack residual, and the sealed-blob consumers a mothership-mode node does not
currently drive. Each is a table entry plus service threading on the same pattern, not a new
mechanism.
