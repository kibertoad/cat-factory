---
'@cat-factory/sandbox': minor
'@cat-factory/app': minor
---

Make the requirements-review product-scope boundary visible to both graders and humans.

The `requirement-review` rubric now carries a `Product scope discipline` dimension (weight 2).
Without it neither the Sandbox judge nor `cat-bench` could see the change that confined the stage
to the product / business layer: a well-written, well-calibrated _technical_ finding scored fine on
every existing axis, since `signal_noise` grades volume rather than layer. `gap_coverage` is
narrowed to product-level gaps for the same reason.

The two hand-kept copies of the rubrics (`@cat-factory/sandbox` and the benchmark harness) are now
pinned equal by a conformity test, since a dimension added to one and not the other fails nothing
on its own and just makes the two surfaces' scores quietly incomparable.

The requirements-review window gains a `requirements.scopeNote` line explaining that the stage
covers product and business requirements only and that technical decisions are settled later by the
Architect and Researcher steps. Without it the absence of technical questions reads as the reviewer
having missed something.
