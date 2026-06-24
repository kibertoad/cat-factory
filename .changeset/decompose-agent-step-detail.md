---
'@cat-factory/app': patch
---

Refactor (no behaviour change): decompose the ~1,260-line
`AgentStepDetail.vue` step-detail overlay so the component is orchestration only.
The live elapsed-time clock, the prose reader (heading outline / collapse /
scroll-spy), and the GitHub-style approval-review state machine each move into a
focused composable (`useStepTimer` / `useStepProse` / `useStepApproval`), and the
two cleanly-presentational sections (`StepMetadataCard`, `StepTestReport`) move into
child components. The template's DOM relationships (scroll-spy refs + in-document
review highlights) are preserved byte-identically; only the script logic and two
display sections are extracted.
