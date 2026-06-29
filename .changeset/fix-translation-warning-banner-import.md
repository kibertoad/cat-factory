---
'@cat-factory/app': patch
---

Fix `Failed to resolve component` console errors on the board page.

Several components that live in subdirectories of `components/` were used by their bare basename in templates without an explicit import. Nuxt's path-prefixed auto-import registers them under a prefixed name (e.g. `LayoutTranslationWarningBanner`, `PipelineIterationCapPrompt`), so the bare tags never resolved. Added the missing explicit imports for `TranslationWarningBanner` (index.vue), `TaskEstimateBadge` (InspectorPanel.vue), and `IterationCapPrompt` (AgentStepDetail.vue, BrainstormWindow.vue, ClarityReviewWindow.vue, RequirementsReviewWindow.vue).
