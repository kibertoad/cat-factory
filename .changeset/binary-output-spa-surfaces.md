---
'@cat-factory/contracts': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

Give binary-output steps their two SPA surfaces: a place their stored artifacts are read, and a
place their storage service is picked.

`PipelineStep.binaryOutputs` has been recorded since the feature landed and nothing rendered it,
so a deployment running a generator kind could see that a step succeeded and had no way to find
what it delivered. The read surface is a shared section resolved from the active step in
`ResultWindowShell` (plus the generic step-detail panel, which the shell is not involved in),
beside the effort and pre-PR-validation sections — deliberately NOT a `presentation.resultView`
a generator declares. The record's scope is a union the declared-view seam structurally cannot
follow: the engine writes it when the step's KIND carries the trait **or** the STEP carries a
selection, so a trait-carrying kind dispatched under an overriding kind records artifacts against
a step whose own kind declares some other window. Resolving off the step instead makes the
surface follow the record, costs a deployment no registration, and leaves a generator free to
declare a result view for its own output rather than choosing between its output and its
artifacts.

The parse keeps six outcomes apart on purpose — not started, still running, no declaration, an
unreadable one, an explicit "stored nothing", and actual artifacts — and five of them are not an
empty list, so the surface renders the discriminant rather than a list that happens to be empty;
state copy comes from one exhaustive `Record`, so a seventh outcome fails the typecheck instead of
rendering a missing key. Every counted loss keeps its own line and its own number (an unknown
service id is not a malformed entry is not a truncated tail), and the one join the report cannot
make itself — did the artifact go through the service the step actually pointed at? — is derived
from the step's own recorded selection, so it needs no catalog read and reads the same on a run
whose services were withdrawn since. "Never briefed" is the section's ABSENCE, and so is a
gated-out step's; a step not started YET resolves the other way, since where its artifacts will
land is worth stating before it runs.

The two unknown-service facts are DISJOINT FIELDS rather than one list plus a flag: the report's
own `unknownServices` mixes the step's lost target with ids the agent invented, so a surface
reading it raw labels every unknown id as the step's own storage service and drops the invented
ones. `targetUnknown` owns the first and `unknownDeclaredServices` owns the second, so naming
either cannot mis-state the other — the exclusion lives in the read model, where it is tested,
not in a renderer's filter.

For the picker, the SPA had no way to know which kinds are generators: `BINARY_OUTPUT_TRAIT`
never left the backend. It is now projected onto the snapshot's custom-kind entry as a boolean
beside `container` — the precedent that the snapshot carries the facts the SPA branches on, not
the backend's trait vocabulary — and asked of the REGISTRY rather than read off the declaration,
so a trait ASSIGNED to an existing kind projects like a declared one. The picker offers the
RESOLVED catalog (`asset-storage`-tagged for the storage half; the whole catalog with
`generation-context` first for the context half, since that tag is conventional and admission
enforces only existence), because admission re-validates against that same catalog at every
start — an id offered from a stale client copy would save clean and fail a refusal cycle later.
It mirrors the admission refusals inline, in translated copy keyed off the same issue vocabulary,
and stays in BOTH interface tiers: this is a required input, not an override, and hiding it in
basic mode would leave a step that cannot be saved with no way to find out why.

Reviewers: the load-bearing decision is the surface's PLACEMENT (shell section, not a declared
result view) — §1.2 of the downstream proposal argued the other way and accepted "a step whose
kind declares a different view has nowhere showing its artifacts" as a consequence; that is the
exact case the union recording rule creates, so it is not one to accept.
