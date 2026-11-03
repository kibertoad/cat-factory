// A page's own query string, for the screens that read it from `window.location` (the MCP
// authorization consent and the tool-server OAuth callback). The decorator puts the story's
// parameters on the preview frame's URL. It keeps Storybook's own parameters and removes each one
// in `owned` first, so a value an earlier story set does not stay.
import { h } from 'vue'
import type { Decorator } from '@storybook/vue3'

/** `story()` is called once, outside the render function, as in `withSeed`. */
export function withQuery(owned: readonly string[], params: Record<string, string>): Decorator {
  return (story) => {
    const Story = story()
    return {
      setup() {
        const search = new URLSearchParams(window.location.search)
        for (const name of owned) search.delete(name)
        for (const [name, value] of Object.entries(params)) search.set(name, value)
        window.history.replaceState(null, '', `${window.location.pathname}?${search}`)
        return () => h(Story)
      },
    }
  }
}
