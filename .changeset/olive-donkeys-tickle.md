---
'@cat-factory/app': patch
---

Refresh the frontend dependency tree — direct and transitive — to the newest versions published
before the `minimumReleaseAge` supply-chain cutoff. Ranges + lockfile only, no source changes.

Only `nuxt` moved as a declared range (`^4.5.0` → `^4.5.1`, mirrored in `deploy/frontend`); every
other direct dependency of the layer was already sitting on its newest cooldown-compliant release,
so the substance of this change is the transitive re-resolution: `@nuxt/*` 4.5.0 → 4.5.1, the
`rollup` 4.62.2 → 4.62.3 family, `@tiptap/*` 3.29.0 → 3.29.1 (via `@nuxt/ui`), `@dxup/nuxt`,
`@vitejs/devtools-kit`, `tailwind-variants`, `minimatch`, `exsolve` and the browser-data packages.

`typescript` deliberately stays on `^6.0.3` here while the backend is on `7.0.2`: TS 7 is the
native compiler and `vue-tsc` drives the JS-based TypeScript API, so the frontend layer and the
runner harnesses are the TS-6 world until the language-tools side lands native support. `sherif`
ignores `typescript` for exactly this reason, so the split does not trip the monorepo lint.

The four `pnpm-workspace.yaml` singleton overrides (`vue`, `vue-router`, `@modular-frontend/core`
and the `@vue/*` family) still resolve to exactly one copy each after the bump — Nuxt 4.5.1 still
asks for `vue-router@^5.2.0`, so the pin's rationale is unchanged and none of the notes needed
editing.
