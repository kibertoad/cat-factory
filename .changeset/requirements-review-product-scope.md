---
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
---

Confine the requirements-review stage to the product / business layer.

The reviewer was routinely raising technical design questions — which library to use, how to shape
an endpoint, whether to cache — and the incorporation editor was writing the resulting decisions
into the standardized requirements document. Both ask a product owner something they cannot answer,
bury the questions only they can, and pre-empt the `architect` and `researcher` steps, which settle
the technical layer later with the repository and the in-repo `tech-spec/` in hand.

All three prompts of the flow (reviewer, incorporation editor, Requirement Writer) now fold in one
shared scope-boundary block: what is in scope (behaviour, business rules, actors and permissions,
data meaning, scope boundaries, quality expressed as a business outcome), what is out (technology
choice, architecture, API and schema shape, algorithms, performance technique, infrastructure,
coding and test approach), and the test to apply to each point — could a product owner who does not
read code settle it from business knowledge alone? The matching user prompts restate it, since they
land last in context and carry the output contract. Two behaviour notes: a technical concern is now
dropped outright rather than kept at a low severity, and raising no findings at all is stated as the
expected outcome for purely technical work.

Prompt versions bumped together: `requirement-review@v4`, `requirement-rework@v3`,
`requirement-writer@v3`.
