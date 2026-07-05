---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

feat(documents): workspace-linked template + exemplar documents per DocKind (doc-task WS1 items 2–4)

A workspace can now point a document kind at its OWN template and example documents, reusing
the existing documents integration end-to-end (no new fetch machinery). A single `role`
(`template` | `exemplar`) + `docKind` tag on the projected `documents` row — sitting alongside
the block-scoped `linkedBlockId` anchor — models both:

- **Template** (singular per kind): its parsed section headings REPLACE the built-in skeleton
  for that kind. Resolved through one shared seam (`resolveDocTemplate`) that BOTH the
  doc-authoring prompts (via the engine-resolved `block.docTemplateBody`) and the `doc-quality`
  gate provider go through, so the writer and the gate never check against different sections.
- **Exemplars** (multi-valued per kind): "good examples to emulate" surfaced to the author
  agents alongside a new set of built-in curated exemplars.

The `documents` table gains nullable `role`/`doc_kind` columns (D1 migration ⇄ Drizzle schema +
generated migration), with new `DocumentRepository` role methods mirrored across both stores and
asserted by the cross-runtime conformance suite. The Node facade's Drizzle migration is the
merge node that collapses the two pre-existing divergent snapshot leaves. New workspace-scoped
routes (`GET`/`POST /document-role-links`, `POST /document-role-links/remove`) back a
per-DocKind template/exemplar management panel in the Integrations hub (i18n in all 8 locales).

Breaking (pre-1.0, acceptable): the `documents` projection wire shape gains `role`/`docKind`
fields; stale rows simply carry nulls.
