---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Custom manifest types can now declare an optional `defaultManifestPath` and `fixerPrompt`.
A `custom` service prefills its manifest path from the type's default on selection, and
"Detect from repo" resolves the path monorepo-aware (keep an accurate current value; else
the exact default within the service subtree/repo root; else, for a bare filename, one level
deep; else pre-fill the default location). A new **Generate / fix manifest** button (shown
only when the type defines a `fixerPrompt`) dispatches the fixer coding agent — reusing the
durable `env-config-repair` run — to create the manifest at the entered path or fix it when
invalid, after best-effort `validateRepo`. Adds the `default_manifest_path` / `fixer_prompt`
columns to `custom_manifest_types` on both runtimes (D1 + Drizzle).
