// A full garbage collection in this session's renderer before each stories file runs.
//
// A Vitest session runs all its stories files in one renderer process, each file in a new iframe,
// and each finished file leaves its whole module graph as garbage. V8 sizes a renderer's heap as
// if the renderer had the machine to itself, so it collects that garbage late, and the sessions'
// renderers together can fill the machine. Collecting here keeps each renderer to about one file's
// worth. `cdp()` is Vitest's session to the page over the Chrome DevTools Protocol, so this runs
// only with Playwright's Chromium, and fails the file loudly anywhere else.
import { beforeAll } from 'vitest'
import { cdp } from 'vitest/browser'

beforeAll(async () => {
  await cdp().send('HeapProfiler.collectGarbage')
})
