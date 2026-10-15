import { h } from 'vue'
import UApp from '@nuxt/ui/components/App.vue'
import { __resetConsumerModulesForTest } from '../../../frontend/app/app/modular/registry'
import { installApiResponses, startApiWorker } from '../../../frontend/app/app/stories/api'
import type { Preview } from '@storybook/vue3'

// Every story renders inside `UApp`, exactly as `app.vue` does.
//
// This is not cosmetic. Nuxt UI's overlay primitives resolve their provider from `UApp`, and
// without it they render NOTHING: `IconButton` came out as an empty comment node because its
// `UTooltip` collapsed with `Injection Symbol(TooltipProviderContext) not found`, taking the
// button with it. A story that silently renders nothing is worse than one that throws.
//
// `UApp` is IMPORTED, not written as a tag in a template string. A decorator's template is
// compiled by the Vue runtime compiler, which knows nothing about Nuxt's auto-imports, so
// `<UApp>` there resolves to a literal `<uapp>` element that provides nothing and looks fine in
// the DOM. Components inside a story's own `.vue` file are a different matter: those are
// compiled by Vite with Nuxt's transform and auto-import normally.
/**
 * Apply a colour mode the way the app does: a class on `<html>`.
 *
 * `tokens.css` is dark-first (`:root` holds the dark values, `.light` overrides them), so the
 * class is not a cosmetic switch. Without it a story renders dark tokens on a white page.
 */
function setColorMode(mode: string): void {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(mode)
  root.style.colorScheme = mode
  try {
    window.localStorage.setItem('sb-color-mode', mode)
  } catch {
    // Blocked storage only costs the first paint after a reload.
  }
}

/**
 * Forget what the last story left in the browser's cookies.
 *
 * The app persists nine Pinia stores in cookies: the interface tier and its rail, the role, the
 * work view, the agent tier, the lane view, the tutorial progress, the theme, the active account
 * and the session. A cookie outlives the story that set it, so after the advanced
 * `UiModeSwitcher` story every later story rendered in the advanced tier, whatever its seed left
 * unsaid. The language cookie goes too, so every story starts in English. A store reads its
 * cookie when the preset builds the story's Nuxt app, which is after `beforeEach`.
 */
function clearCookies(): void {
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
  }
}

const preview: Preview = {
  globalTypes: {
    colorMode: {
      description: 'Colour mode',
      defaultValue: 'light',
      toolbar: {
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },

  // The preset builds a FRESH Nuxt app per story and runs `applyPlugins` every time, but the
  // modular registry's consumer list is a module-level array that survives across stories. So
  // `acme-security.client.ts` contributed `acme:security` again on the second story and
  // `resolve()` threw "Duplicate module ID", blanking the preview from then on. That duplicate
  // guard is correct and worth keeping; what is wrong here is the array outliving the app.
  //
  // The reset has to run BEFORE the plugins do. Storybook's `beforeEach` is in the prepare
  // phase, ahead of `renderToCanvas` where the preset's `setup()` callback lives; a decorator
  // would be too late. The helper is named for tests because tests were its first caller.
  beforeEach: (context) => {
    __resetConsumerModulesForTest()
    clearCookies()
    // A story's API responses (`parameters.api`), installed before the component's loaders run.
    // Every story replaces the previous story's set, so none answers for another.
    installApiResponses(context.parameters.api ?? [])
  },

  // One msw worker for the whole preview: registering a service worker per story would be slow
  // and race the first request.
  beforeAll: async () => {
    await startApiWorker()
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loaders: [(context: any) => setColorMode(context.globals.colorMode ?? 'light')],

  // Width is a story PARAMETER because a component stretched to the full canvas is a lie about
  // where it lives: `RunFailureSummary` sits in an inspector panel, not across 1280px, and the
  // full-bleed version reads as a different design. `panel` is the inspector, `narrow` a card,
  // and the default is free-flowing for primitives that genuinely have no container.
  //
  // `story()` is called ONCE, outside the render function. Each call builds a new component
  // object for the decorators inside this one, so calling it while rendering gave Vue a new
  // component type whenever this decorator re-rendered, and the whole story remounted: a single drag on
  // the board canvas remounted the canvas three times.
  decorators: [
    (story, context) => {
      const Story = story()
      const width = { panel: '420px', narrow: '280px', prose: '640px' }[
        context.parameters.width as string
      ]
      // A fullscreen story (the board canvas) owns the whole frame, so it gets no padding.
      const padding = context.parameters.layout === 'fullscreen' ? '' : 'p-4'
      return () =>
        h(UApp, () =>
          h('div', { class: padding, style: width ? { maxWidth: width } : undefined }, h(Story)),
        )
    },
  ],
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    // `todo` REPORTS axe violations in `test:stories` without failing on them. `error` is the
    // right setting and is not honest yet: the baseline has real violations on `main` (the
    // `text-dimmed` token at 2.63:1, SecretInput with no label, DecisionBadge losing its
    // accessible name when compact). Flip this to `error` when that baseline is clean, so the
    // lane starts refusing new ones.
    a11y: { test: 'todo' },
  },
}
export default preview
