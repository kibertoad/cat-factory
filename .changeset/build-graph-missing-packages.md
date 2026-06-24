---
"@cat-factory/sandbox": patch
"@cat-factory/local-server": patch
---

Add `@cat-factory/sandbox` and `@cat-factory/local-server` to the root `tsc -b`
build graph (`backend/tsconfig.build.json`). They were publishable (`private: false`,
`publishConfig.access: public`) and declared `files: ["dist"]`, but neither was
referenced by the build graph nor pulled in transitively, so `pnpm build` (which
`ci:publish` runs before `changeset publish`) never produced their `dist`. The last
release therefore published both with only `package.json` + `LICENSE` and no code.
This patch re-releases them with their built output. (`@cat-factory/consensus` was
unaffected — it builds transitively via the cloudflare/node graphs.)
