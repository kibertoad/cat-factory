# Per-workspace capability credentials

Status: **slices 1, 2 and 4 landed (backend end to end, the SPA surface, and the store-only
declaration); slice 3 (conformance) open.**

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
- [x] **4. Retire the environment default for a multi-tenant deployment.** Not by removing it:
      `capabilityCredentialEnvironmentFallback: false` on every facade composes the chain without
      the environment resolver, and the view reports what was composed. The DEFAULT is untouched
      (`true`), because whether a hosted deployment should ship store-only is a product call and
      this slice deliberately does not make it.
      ([PR #1631](https://github.com/kibertoad/cat-factory/pull/1631).)

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

### Three decisions slice 4 forced

9. **The composition returns the DESCRIPTION with the resolver, so nothing can re-assert it.**
   `buildToolSecretChain` (`@cat-factory/server`) is the single site all three facades compose
   through, and it hands back `{ resolver, environmentFallback }`. Previously each facade's
   executor builder assembled its own chain, which is the shape that lets two runtimes drift about
   a precedence rule, and neither could be read by the surface that has to describe it: the
   controller asserted `true` beside a chain it never saw. Consequence worth stating: the facades
   now build the chain at the composition ROOT and pass it down, so the executor builders take a
   resolver rather than the store, and the Worker stopped building a second
   `CapabilityCredentialsService` for the executor alone. What that consequence then forced is
   decision 11.
10. **`environmentFallback` is a TRI-STATE, because a deployment's own resolver is undescribable.**
    The seam's documented meaning is that `createToolSecretResolver` REPLACES the chain, so a
    deployment may have wired Vault, or the environment, or both, and neither boolean is a claim
    the platform can make. Absent is that answer, and the SPA renders it as a third line that
    states only what is known. Both guesses fail in opposite directions and both fail silently:
    `true` tells an operator a blank row may still be working when nothing will ever resolve it,
    `false` sends them hunting for a value that already answers. Rejected alternative: reporting
    the ordered SOURCE LIST (`['workspace-store', 'deployment-environment']`) instead of a flag,
    which reads richer and is not: the only extra fact it carries, "the store is not consulted at
    all", is unreachable, since the controller already 503s when the store is unwired, and for a
    custom resolver the list would be the same guess in a longer shape.
11. **The executor takes the chain as a REQUIRED dependency, because the only default it could
    carry failed OPEN.** Moving composition to the root left both executor builders with a bare
    deployment-environment default "for a caller assembling this executor without that root".
    That default is the leak the store exists to prevent, reachable by dropping ONE optional field
    in a facade whose every neighbouring link is optional: the per-workspace store stops being
    consulted, every tenant resolves off the deployment's own vars, and nothing throws or logs
    because env-only is a perfectly valid chain. It also contradicted the decision one paragraph
    up, where store-only-with-no-store refuses LOUDLY rather than quietly re-adding the
    environment. Making the field required moves that whole class of regression to a compile
    error, and the standalone caller loses nothing: `buildToolSecretChain` is exported, and calling
    it is what gets them the description the checklist renders as well as the resolver. General
    form: **a default is only safe where the safe answer is the convenient one.**

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
- **Store-only with NO store is a refusal, not a quiet no-op.** `ENCRYPTION_KEY` is what wires the
  store, so a deployment can declare the chain store-only and have nothing in it. The composition
  logs an `error` naming the misconfiguration and returns a resolver that answers nothing, rather
  than silently re-adding the environment (which would ignore the declaration) or throwing (the
  Worker composes per entry point, so that would take out every request). The operator surface
  already states the other half: the controller 503s naming `ENCRYPTION_KEY`.
- **A composition-time report is said ONCE PER PROCESS, because this runs per container build.**
  On the Worker that is per request, per cron tick and per queue message, so a line repeated per
  invocation buries the one line that names the problem. The guard is a module-level set keyed by
  problem (per isolate on the Worker), the cadence `validateRegistrationsOnce` already sets for the
  sibling registration checks. Not a counter: a configuration mistake has no rate to watch. The
  same guard covers the WARN for a deployment that set `capabilityCredentialEnvironmentFallback`
  beside its own resolver, which is a declaration the composition cannot honour and so is stated
  rather than dropped.
- **The tri-state's ABSENT copy names no CAUSE, and that is not squeamishness.** Two things land
  on absent: a deployment's own resolver (the deliberate one) and a facade that wired the store and
  dropped the flag (a refactor hazard). Copy that blames the custom resolver makes the second read
  as the first, sending an operator to inspect a resolver nobody wrote. So the line states that the
  chain cannot be described HERE and stops, which is true of both.
- **The declaration list is NOT filtered to the capabilities a workspace's pipelines use.** Which
  kinds a workspace runs changes with every pipeline edit, so filtering makes the checklist flicker
  and hides the key an operator needs to set BEFORE adding the step that wants it.
- **`environmentFallback` was hard-coded `true` in the controller** because all three facades
  composed the chain that way. Slice 4 closed that, and the shape it forced is the entry below.
