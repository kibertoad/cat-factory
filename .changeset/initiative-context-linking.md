---
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/app': minor
---

Let an initiative carry linked context documents and tracker issues, and put them in front of the
whole planning pipeline.

Requirements, RFCs, PRDs and tracker issues can now be attached while CREATING an initiative — the
same staged picker the add-task flow uses, extracted into a shared `ContextAttachmentFields` so the
two surfaces cannot drift. Attachments are linked once the initiative block exists.

The backend gap this closes is that the engine already RESOLVED a block's attachments for initiative
blocks (an initiative is anchored to an ordinary block) and the container already materialised them
under `.cat-context/` — but the initiative agent kinds build their own user prompts and so returned
before the generic `linkedContextSection` fold. The analyst and planner had the files on disk with
nothing telling them the files existed, and `initiative-breakdown`'s system prompt told it to reason
from "any linked context" the user prompt never supplied. All three now fold it in, each in the form
matching its surface (index + `.cat-context/` pointer for the container kinds, inlined bodies for the
inline one).

The interviewer needed wiring rather than a fold: it is an inline service that never passes through
`AgentContextBuilder`. `resolveLinkedContext` moved out of the builder into its own module and both
paths now share it, so the interviewer can never see a different set of attachments than the analyst
and planner that follow it. It is also told to treat what an attachment settles as already answered,
which is the point of attaching a PRD — otherwise the stakeholder is interrogated about exactly the
facts the document they attached already states.

Attachments are still only editable at create time; the inspector's context panels remain task-only.
Pasting a document URL or issue key into the initiative's goal text reaches the planning agents too,
so an initiative created without attachments is not a dead end.
