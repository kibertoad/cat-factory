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
    // Give every overlay the same layered surface the agent-run-details reader uses: the deep
    // `app-950` surface (below `bg-default`) so the `bg-default` panels/cards inside pop, with
    // `border-default` chrome. All tokens are theme role tokens (`app-950` is the hand-defined
    // flipping token for the deep shade), so overlays track dark/light. Applies to all
    // UModal/USlideover instances so they stay consistent without per-instance `:ui` overrides.
    modal: {
      slots: {
        content: 'bg-app-950 ring-default divide-default',
        header: 'border-b border-default',
        title: 'text-highlighted',
      },
    },
    slideover: {
      slots: {
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
