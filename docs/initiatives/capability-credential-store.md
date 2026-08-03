# Per-workspace capability credentials

Status: **slices 1 and 2 landed (backend end-to-end, plus the SPA surface); slice 3 (conformance)
open.**

## Goal

Move the credentials a registered CAPABILITY declares (a tool server's (MCP) `secretKeys`, a
generative binary integration's `credential.key`) off the deployment's environment and into the
per-tenant, sealed, UI-edited store every other credential in the platform already uses. Keep the
environment resolver as the FALLBACK, because for a single-tenant install it is the right mechanism
and the one the operator already has wired.

## Why

`ToolSecretResolver` shipped with exactly one implementation, `createEnvToolSecretResolver`, and an
environment variable is a single-tenant answer. One process serves many workspaces, so one variable
serves them all:

- every tenant's runs authenticate as whoever set the variable, and the vendor bill lands in one
  account;
- a tenant cannot bring its own vendor account, which for a metered image/video generator is the
  normal ask rather than an edge case;
- rotating one tenant's key is a redeploy, and it rotates it for everyone;
- the value is readable by anyone with shell access to the host, and by every other tenant's runs.

Every other credential in the platform went the other way years ago: provider API keys, tracker /
document / runner / observability connections, personal subscriptions, private package registries,
the sensitive test secrets. Capabilities are the subsystem that did not get it, and the gap was
masked because the port LOOKED like the seam: a deployment could "just implement `ToolSecretResolver`".
It could not, until the `createToolSecretResolver` option landed on every facade, and even with the
seam, leaving every deployment to build the store itself means the platform ships a multi-tenant
product with a single-tenant credential story.

## Target pattern

`TestSecretsService` is the pilot to copy, and the resemblance is deliberate: sealed blob plus a
non-secret summary, write-only values, a view that lists KEYS, resolution at dispatch into the job
body out of band. The differences are all forced by what a capability credential IS.

|                | test secrets               | capability credentials                                                                                           |
| -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| scope          | service frame block        | **workspace**: a capability is attached to an agent KIND or selected by a step, neither of which is frame-scoped |
| key vocabulary | operator-invented          | **declared by the deployment's code**, so the surface is a checklist rather than a blank form                    |
| resolution     | one service, one call site | **a `ToolSecretResolver`**, composed in front of the environment one                                             |
| fallback       | none                       | **the deployment environment, per key**                                                                          |

### The five decisions worth re-reading before changing this

1. **Keyed by `(workspace, key)`, not by subject.** The `ToolSecretSubject` discriminator exists so
   two registries minting the same id cannot collide, and a deployment's own resolver can still use
   it. This store ignores it, because the KEY is also the environment variable the agent reads the
   value from, and two capabilities behind one vendor account sharing one key is a supported case
   the generative-integration resolver already dedupes for. Consequence, stated so it is a choice
   rather than an accident: swapping the environment for this store changes WHERE a value comes from
   and not WHO can see it.
2. **Composition is PER KEY.** "First resolver that returns anything wins" would mean a workspace
   that filled in one of a step's three credentials silently loses the other two: a
   half-completed form turning working integrations off, with the run reporting them unavailable
   and nothing naming the cause.
3. **One row per workspace, holding the whole set.** The read is on the dispatch path, the set is
   bounded (≤ 100), and both the resolver and the settings view want all of it. A row per key buys
   a finer write and costs every dispatch an N-row read. The accepted consequence is that a
   single-key delete is a read-modify-write where the last writer wins: one retyped secret, versus
   the N-row shape's cost on every run.
4. **`remote` in mothership mode.** The blob is sealed in the service under the local key, so no
   plaintext crosses the machine API, the `testSecretsRepository` precedent exactly. It cannot be
   `local-sqlite`: a RUN resolves it, and a credential an operator set on the mothership has to
   reach the dispatch that needs it.
5. **The declaration checklist reads generators through `BinaryGeneratorSource`, never the
   registry.** That is the standing rule for that set, and it bites here: the source THROWS rather
   than answering empty when it cannot reach the mothership, so the view carries
   `declarationsIncomplete` and SUPPRESSES the orphan list while it is true. Without that, an
   outage reports every generator credential as orphaned and an operator deletes a working one.

### Three states that are not "an empty list"

- **`orphaned`**: a stored key nothing declares any more, which is what a retired integration or a
  renamed variable leaves behind: a live secret nobody will ever ask for. Reported rather than
  filtered, because only the operator can tell "delete this" from "the deployment regressed".
- **`declarationsIncomplete`**: the checklist may be short. Its own flag rather than a failed
  request: the stored half is still readable, and locking an operator out of their credential list
  during someone else's outage is the worse answer.
- **`environmentFallback`**: an unstored key may still resolve. The UI must not call a blank row
  "missing" while this is true.

### The reserved floor still binds, and it is about the KEY NAME

A stored credential is injected into an agent process under its key name, so the write boundary
holds it to BOTH reserved lists: `isReservedPlatformEnvKey` (the platform's own configuration,
storing `ENCRYPTION_KEY` would not read the deployment's key, since this store answers first, but
the declaration it satisfies is refused at boot, so accepting it lets an operator fill in a
credential that can never be asked for) and the toolchain names (`PATH`, `npm_config_*`, `GIT_*`),
which reconfigure the run instead of authenticating a call.

## Slices

- [x] **1. Backend end to end.** Contracts + kernel port + `CapabilityCredentialsService` +
      `createWorkspaceToolSecretResolver` / `composeToolSecretResolvers` + the declaration join +
      `secrets.manage`-gated controller + D1 and Drizzle repositories and migrations + the RPC
      allow-list entry with its round-trip and cross-account-refusal cases + both facades wiring the
      composed chain by default. ([PR #1620](https://github.com/kibertoad/cat-factory/pull/1620),
      landed with the facade seam it depends on.)
- [x] **2. The SPA surface.** `CapabilityCredentialsPanel.vue` in the Infrastructure window,
      beside the package registries: the checklist, who wants each key and whether it is required,
      the three states above, write-only inputs and a per-key delete. Hidden rather than disabled
      without `secrets.manage`, and hidden when there is nothing to show. Slice 1 shipped no write
      the panel could use, so it brought a per-key one with it; see the two decisions below.
- [ ] **3. Conformance.** A cross-runtime assertion that a stored credential reaches a dispatch's
      job body and an unstored one falls through to the environment. Deliberately deferred: the
      conformance harness replaces `ContainerAgentExecutor` with a fake, which is the same reason
      tool servers are not asserted there today, so this slice is really "give the harness a seam
      that can observe the resolved job body", and it should be scoped as that rather than smuggled
      in as a test.
- [ ] **4. Retire the environment default for a multi-tenant deployment.** Not by removing it: by
      letting a deployment declare `createToolSecretResolver` as store-ONLY and having the view
      report `environmentFallback: false`, which the SPA already reads. The open question is whether
      a hosted deployment should default that way, which is a product call rather than a code one.

### Three decisions the SPA slice forced

6. **A per-KEY write, because the checklist could not use the set-replacing one.** Slice 1 shipped
   `PUT /capability-credentials` (whole set) and a per-key DELETE, and the asymmetry was a hole:
   the client never receives the values, so re-sending the set means re-typing every secret, and
   sending only the edited key REPLACES the set, meaning a workspace that fills in its second
   credential silently deletes its first. `PUT /capability-credentials/:key` is the twin of the
   delete, read-modify-write like it, and it carries the ceiling the whole-set schema carries or
   it is simply a way around it. The whole-set PUT stays: it is the right operation for an API
   caller declaring a set at once, and the only way to clear one.
7. **The tab gates on CONTENT, not just availability.** Every other Infrastructure tab appears
   once its module answers. This panel is a checklist projected from the deployment's CODE, so a
   build registering no tool server and no generative integration has no credential to type and
   the tab would be a dead end. It is hidden when the declared list, the orphan list and
   `declarationsIncomplete` are all empty/false, and `declarationsIncomplete` is what keeps it
   when the emptiness is an OUTAGE rather than an answer.
8. **The per-key writes are REV-GUARDED, not last-writer-wins.** The row is ONE sealed blob, so a
   per-key save is read-modify-write over the whole set, and blind it loses updates: two operators
   saving DIFFERENT keys, and the loser's key vanishes while their save returned success. The
   loss surfaces later as a dispatch silently resolving nothing, which is this initiative's own
   failure mode. Slice 2 first shipped that trade documented ("costs one retyped secret"), but the
   cost is understated (the loss is silent) and the repo convention ("a one-JSON-blob row is
   rev-guarded, never blind-upserted") already names the remedy: a `rev` column plus
   `compareAndSwap`/`deleteIfRev`, with the service reloading and re-applying the single-key edit
   on the winner's snapshot (the `mutateReview` pattern). Rejected alternative: a row per key,
   which buys the fine-grained write at the cost of turning the dispatch path's one read into N.
   The whole-set PUT stays blind on purpose (replacing whatever is stored IS its semantics) and
   bumps the stored rev in SQL so a concurrent per-key save still loses its swap and retries.
   Each write also stamps `updatedAt` on the touched key only: "last set" is a per-key fact the
   checklist renders, so re-stamping the set would falsify every neighbour's date.

## Gotchas the pilot surfaced

- **`collectDeclaredCapabilityCredentials` enumerates through the KINDS**, not off the tool-server
  registrations, so the list is the servers some registered kind can actually reach: a server
  registered by id and attached to nothing never runs, and a credential for it is a key an operator
  fills in for no dispatch. That makes one server visible once per referencing kind, hence the
  dedupe on `(subject, id, key)`, the identity of the DECLARATION, not the key, so a second
  capability's name is not dropped from `declaredBy`.
- **The join lives in `@cat-factory/server`, not in the store's service.** It reads registry state,
  and the generator half must go through `BinaryGeneratorSource`, which only the composition root
  can supply. Putting it in `@cat-factory/integrations` would have dragged that package into the
  agent-kind registry graph for a read that is presentational.
- **The declaration list is NOT filtered to the capabilities a workspace's pipelines use.** Which
  kinds a workspace runs changes with every pipeline edit, so filtering makes the checklist flicker
  and hides the key an operator needs to set BEFORE adding the step that wants it.
- **`environmentFallback` is hard-coded `true` in the controller** because all three facades
  currently compose the chain that way. When slice 4 makes it configurable, it must be read from
  what the facade actually composed rather than re-asserted: the flag's whole job is to describe
  the real chain.
