---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Keep what a status poll observes, and stop the environment investigation reasoning past it

The first real environment investigation produced a confident wrong verdict: it blamed a platform
readiness gate that had worked correctly, told a human to go change three behaviours that already
behave as asked, and filed the actual cause as one bullet underneath. Three defects behind it, all
in what the platform recorded rather than in what the model did with it.

**A status poll now persists what it captured.** `refreshStatus` handed the whole provision-field
bag to the provider and then wrote a patch that omitted it, so `provision_fields_cipher` was
written once at create time and never again. For an asynchronous provider the create response is
the least informative answer it will ever give (no finished deploy job, no load balancers, no
readiness detail), so every fact worth capturing arrived on a poll and was discarded, and an
adapter recording its balancer health and DNS resolution on each poll was writing into a field
nothing read. A stated bag now REPLACES the stored one, whole, and
`ProvisionedEnvironment.fields` is nullable: `null` states nothing and keeps what is stored, which
is what stops a status endpoint answering a narrower shape than its create endpoint from erasing
teardown state. The docstring described merge semantics and the code implemented neither.

The corollary binds every adapter: a statement has to be COMPLETE. The generic manifest provider's
`status()` therefore carries the keys this response said nothing about over from the stored bag
under its freshly mapped values, because its bag is built from two paths a status endpoint commonly
omits (the id usually rides the request path, not the body). Its no-`status`-template fallback and
the Compose provider's no-project branch answer `null`, which is what an adapter that read nothing
owes.

**A poll the provider ANSWERED leaves a trail.** The provisioning log records a poll that threw and
a poll that turned an environment `failed`; any other answer wrote nothing anywhere, so a readiness
wait that polled for four minutes left two rows a second apart at the create, and nothing in the
data distinguished "nothing polled" from "polling is not logged". The environment row carries
`lastPolledAt` plus a `pollCount` floor (a row per poll being the wrong shape at a ten-second
cadence), both projected onto `EnvironmentHandle`. It counts ANSWERS rather than successes, a
`failed` verdict included: the claim a reader gets wrong is how much polling happened, and reading
it as a success count would hand an investigation twenty-two successes for an environment that
failed all twenty-two.

**The investigation's evidence carries the route, and one timeline.** The bundle gains
`route` (the addresses the provider stated and what dialling them proved) and folds the proof into
the timeline dated from its own `checkedAt`, so an ordering claim that contradicts a timestamp the
platform held is structurally hard to state; the verdict that filed this said the reachability
check "settled roughly at the moment of the create request" against a `checkedAt` reading 4m18s
later. The provisioning log's own state is an entry in that list too, in each of the four ways it
can have one (this deployment keeps none / this environment is on no run / it was read and holds
nothing / the read threw), because once the record's dates and the poll marker joined the timeline
an absent log stopped being distinguishable from an empty one by the list coming back short. The
platform also COMPUTES the determinate cause where its own inputs settle one (a `not_reached` proof
beside an empty candidate list means nothing but the environment's own name was ever available to
dial; a `no_candidate` proof BESIDE stated addresses is the different determinate cause that the
URL published none, not that the provider stated no addresses) and tells the model it outranks
anything inferred from apparent ordering. Prompt bumped to `environment-investigation@v2`, which
also forbids reading the absence of an entry in a record of attempts as the absence of the event,
and names the route evidence and the poll marker as sources an answer may cite.

The route evidence is scrubbed and bounded on the way into the bundle, like every other
provider-authored section: `candidates` comes off a response mapping with no declared length and a
probe's `detail` is the only field carrying a raw error string. The attempt list now has ONE
renderer (kernel's `describeRouteTargets`) rather than a copy per surface, which is how one of them
came to ship that detail unredacted while its neighbour scrubbed it.

**A route proof survives on what it established.** The fold compared the candidate list as a
SEQUENCE, so any later poll whose list merely reordered dropped the proof, and nothing took
another: `proveEnvironmentRoute` is reached only from the deployer's frame settle, which never runs
again for a settled frame. A provider stating addresses from a live DNS answer does not control
their order. A `reached` proof now survives while the target it names is still on offer (compared
after the same trim the prober applies, so a padded address stops failing to match its own proof),
any other proof while the candidate set is unchanged, and `refreshStatus` re-proves a `ready`
environment whose proof it had to drop.

The re-prove is bounded, and the bound needed a third field. It runs at most once a minute per
environment, because a provider that genuinely re-states a different candidate set on every answer
would otherwise add up to twenty seconds of sequential dialling to every poll of a ten-second
readiness wait. Pacing that off the proof's own `checkedAt` does not work: the first time the poll
waits, it persists the drop, and the next poll reads an environment nothing ever dialled. So
`EnvironmentReachability` carries `probedAt` (when the platform last LOOKED, kept across a dropped
verdict and a moved URL), which is also what lets an environment settled `unproved` before a
deployment wired its prober get proved once one exists: `unproved` is a proof never taken, and it
survives the fold indefinitely.

Internal break: `ProvisionedEnvironment.fields` is `ProvisionFields | null` (nullable, not
optional, so every provider still has to decide), `EnvironmentRecord` gains `lastPolledAt` and
`pollCount`, and the stored reachability blob gains an optional `probedAt`. Both facades add the two
columns (D1 migration 0099 and the matching Drizzle migration) and existing rows read back as
never-polled, which is what they are; `probedAt` needs no migration (it is inside the existing JSON
column) and a value written without one re-proves at its first opportunity.
