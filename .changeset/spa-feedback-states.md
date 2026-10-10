---
'@cat-factory/app': patch
---

Make the SPA's three feedback states look the same everywhere: toasts, loading and empty states.

Every toast that is not a failed call now goes through `useActionToast()` (`success`, `info`,
`warning`, `error`), beside the existing failure funnel. The tone decides the colour, the icon and
the duration, so all success toasts render identically. Success and info toasts dismiss after the
default; warning and error toasts stay until closed. Some toasts change tone as a result (an
uncoloured "disconnected" or "attached" toast is now a green success).

Loading uses the Nuxt UI `loading` prop where a component has one, `USkeleton` rows while an async
panel or list waits on its first fetch, and the new `common/Spinner.vue` for a bare loading glyph.
The spinner honours reduced motion. The skeleton fill is `bg-accented` app-wide, because the
default `bg-elevated` matched the light-mode overlay surface and could not be seen inside a modal.
Empty lists and panels render `common/EmptyState.vue`, which now wraps Nuxt UI's `UEmpty`.

`scripts/check-frontend-feedback.mjs` bans `toast.add(` outside the two toast composables and
`animate-spin` outside the spinner.
