---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
---

Fix the spec-writer ⇄ spec-companion infinite-rework loop that bled tokens on
every spec task. A companion grades the producer step's `output`, but an
artifact-producing container agent (the spec-writer, the Blueprinter) returns its
raw Pi transcript summary there, not the document it committed. The spec-companion
was therefore grading a 2,000-char transcript fragment, declared every pass
"unreviewable", and looped the producer to its rework cap (~3 wasted spec-writer
container runs) on every spec task. Telemetry confirmed the spec itself was valid
and NOT truncated (`finish_reason='stop'`, well under the output cap) — the bug was
the handoff, not the model or the output limit.

The engine now replaces a finished producer step's reviewable output with a
deterministic rendering of the structured ARTIFACT it emitted (`renderSpecForReview`
/ `renderBlueprintForReview`), via a single universal seam keyed off WHICH artifact
the result carries (`reviewableArtifactOutput`) rather than a per-agent special
case — so every artifact-producing agent with a companion, today and future, grades
the product instead of the transcript. The SPA reader and downstream `priorOutputs`
see the real document too. A cross-runtime conformance assertion pins this so a
facade can't drift back to surfacing the transcript.
