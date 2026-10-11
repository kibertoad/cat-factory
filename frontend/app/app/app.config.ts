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
    // A skeleton is one step darker than Nuxt UI's `bg-elevated`, which is also the default
    // skeleton fill. Many windows paint their body or inner cards `bg-elevated` or `app-950`
    // (neutral-100 in light mode, the same colour), and a default skeleton there is invisible.
    // `bg-accented` reads on those, on `bg-default`, and in dark mode.
    skeleton: {
      base: 'animate-pulse rounded-md bg-accented',
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
