---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
---

Let the pipeline builder's purpose dial narrow the palette per agent KIND, not per section

The dial filtered on the palette's display CATEGORY, so it could only ever remove whole sections
and a kind whose section survived stayed offered however plainly it contradicted the purpose. A
`review` pipeline reviews an existing pull request and opens none, yet it was offered the two
agents that WRITE documentation into the repo, because `docs` had to stay for the Domain Rules
Reviewer; a `planning` pipeline was offered the bug triage and PR-review kinds; and `document` and
`research` had identical rows, so moving the dial between those two settings narrowed nothing at
all.

`AgentPresentation` gains an optional `purposes`, and `purposeSuggestsAgentKind` is what the
palette now filters on. The two narrowings INTERSECT: a declaration may only hide more, never buy
a kind back into a purpose its section is not offered to, which is what keeps palette relevance
inside what the save gate will accept whatever a deployment declares. Declaring nothing is the
normal case and behaves exactly as before, so a registered kind that says nothing is as visible as
it was; a declared list naming only purposes the reader cannot name is read as no declaration
rather than as excluding everything.

The built-ins that belong to one use-case now say so (the document-authoring family, the bug
triage and PR-review kinds, the spec/blueprint/architecture kinds, the initiative breakdown), which
is a visible narrowing of what the palette offers at every purpose, `build` included: the six
document-authoring kinds belong to `document` alone and the initiative breakdown to `planning`
alone, so a build pipeline stops being offered them as well. Nothing changes
about what an existing pipeline may CONTAIN or save: `purposeAllowsAgentCategory` is untouched, so
a stored pipeline stays editable in the builder it was built in.
