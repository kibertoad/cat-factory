export default defineAppConfig({
  ui: {
    // The default theme's alias map. It MUST equal `CAT_FACTORY_THEME.doc.colors`
    // (`utils/theme/builtins.ts`): this is what the first paint renders from, before the theme
    // plugin applies the active document over it (`theme.builtins.spec.ts` pins the equality).
    colors: {
      primary: 'indigo',
      secondary: 'violet',
      success: 'emerald',
      info: 'sky',
      warning: 'amber',
      error: 'rose',
      neutral: 'slate',
    },
    // The default button and badge are Nuxt UI's own, stated so they have one visible home and
    // `scripts/check-frontend-variants.mjs` can refuse a literal equal to them (the variant policy
    // in `frontend/app/README.md`). They must stay the PRIMARY tier: a theme's `style.defaults`
    // replaces these for every control that does not state the prop, so the unstyled group is the
    // one a theme restyles, and the quiet chrome states `color="neutral" variant="ghost"` itself.
    button: {
      defaultVariants: { color: 'primary', variant: 'solid', size: 'md' },
    },
    badge: {
      defaultVariants: { color: 'primary', variant: 'solid', size: 'md' },
    },
    // Give every overlay the same layered surface the agent-run-details reader uses: the deep
    // `app-950` surface (below `bg-default`) so the `bg-default` panels/cards inside pop, with
    // `border-default` chrome. All tokens are theme role tokens (`app-950` is the hand-defined
    // flipping token for the deep shade), so overlays track dark/light. Applies to all
    // UModal/USlideover instances so they stay consistent without per-instance `:ui` overrides.
    // The overlay is a black scrim, not Nuxt UI's `bg-elevated/75`: in light mode `bg-elevated` and
    // `app-950` are both neutral-100, so the panel had the same colour as the blanket behind it.
    modal: {
      slots: {
        content: 'bg-app-950 ring-default divide-default',
        header: 'border-b border-default',
        title: 'text-highlighted',
      },
      // The modal paints its overlay colour in the `overlay: true` variant, which is applied after
      // the slot, so the scrim must replace it there. The slideover paints it in the slot.
      variants: {
        // fixed-colour-ok: a scrim darkens the page in both modes
        overlay: { true: { overlay: 'bg-black/50' } },
      },
    },
    slideover: {
      slots: {
        // fixed-colour-ok: a scrim darkens the page in both modes
        overlay: 'bg-black/50',
        content: 'bg-app-950 ring-default divide-default',
        header: 'border-b border-default',
        title: 'text-highlighted',
      },
    },
    // The toaster's scroll region is the ONE `[data-slot='viewport']` the app's own
    // CSS may target: Nuxt UI reuses that attribute for the item list of every menu
    // component too. This marker class is what `main.css` hangs the safe-area offset
    // and the selectable-text rules on, so neither can reach a dropdown.
    toaster: {
      slots: {
        viewport: 'app-toaster',
      },
    },
  },
})
