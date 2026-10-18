import { afterEach, beforeAll, beforeEach } from 'vitest'
const iframe = new URLSearchParams(location.search).get('iframeId')?.split('/').pop() ?? location.pathname
const beacon = (kind: string, extra: Record<string, unknown> = {}) =>
  navigator.sendBeacon('/__mswlog', JSON.stringify({ t: Date.now(), kind, iframe, ...extra }))
let t0 = 0
const res = () => (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((r) => r.startTime >= t0).map((r) => [r.name.replace(location.origin, '').slice(-70), Math.round(r.startTime - t0), Math.round(r.duration)])
beforeAll(() => beacon('file-beforeAll'))
beforeEach((ctx) => { performance.setResourceTimingBufferSize(5000); performance.clearResourceTimings(); t0 = performance.now(); beacon('test-start', { name: ctx.task.name }) })
afterEach((ctx) => beacon('test-end', { name: ctx.task.name, state: ctx.task.result?.state, res: res() }))
// Event-loop lag: a 250 ms timer that fires late means this frame's main thread was blocked.
let current = ''
beforeEach((ctx) => { current = ctx.task.name })
let last = performance.now()
setInterval(() => {
  const now = performance.now()
  const lag = now - last - 250
  if (lag > 1500) beacon('lag', { lag: Math.round(lag), test: current, hidden: document.hidden, vis: document.visibilityState })
  last = now
}, 250)
beforeAll(() => { const g = (globalThis as unknown as { gc?: () => void }).gc; if (g) { const t = performance.now(); g(); beacon('gc', { ms: Math.round(performance.now() - t) }) } })
// Per file: the session page's iframes and the JS heap all its frames share.
beforeAll(() => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
  let frames = -1
  try { frames = window.parent.document.querySelectorAll('iframe').length } catch {}
  beacon('mem', { session: new URLSearchParams(location.search).get('sessionId'), frames, heapMB: m ? Math.round(m.usedJSHeapSize / 1048576) : -1, totalMB: m ? Math.round(m.totalJSHeapSize / 1048576) : -1 })
})
