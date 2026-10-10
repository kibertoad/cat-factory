import { describe, expect, it } from 'vitest'
import { ToolSilenceWatchdog } from '../src/tool-silence.js'

// The tool-silence watchdog in isolation (stuck-run audit F13). `JobRegistry`'s own suite covers
// it end-to-end through a job; these pin the two rules that are invisible from there — that a
// window only ever belongs to the stream that opened it, and that expiry is decided from what
// the window SAW rather than from how the two watchdog windows compare numerically.

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A watchdog whose `lastActivityAt` is driven by the test. */
function build(windowMs: number) {
  let lastActivityAt: number | undefined
  const expirations: number[] = []
  const watchdog = new ToolSilenceWatchdog({
    windowMs,
    lastActivityAt: () => lastActivityAt,
    onExpired: () => expirations.push(Date.now()),
  })
  return {
    watchdog,
    expirations,
    speak: () => {
      lastActivityAt = Date.now()
    },
  }
}

describe('ToolSilenceWatchdog', () => {
  it('fires when a window elapses with output arriving but no tool call completing', async () => {
    const { watchdog, expirations, speak } = build(20)
    const window = watchdog.open()
    const chatter = setInterval(speak, 5)
    await tick(60)
    clearInterval(chatter)
    window.close()
    expect(expirations.length).toBeGreaterThan(0)
  })

  it('does not fire while tool calls keep completing', async () => {
    const { watchdog, expirations, speak } = build(30)
    const window = watchdog.open()
    const work = setInterval(() => {
      speak()
      window.toolCompleted()
    }, 10)
    await tick(90)
    clearInterval(work)
    window.close()
    expect(expirations).toEqual([])
  })

  it('defers a window that elapsed in silence, so the hang stays the inactivity watchdog’s', async () => {
    // The run spoke once, before the window was armed, and then went quiet. Firing here would
    // report "kept talking, completed nothing" about a run that stopped talking — the wrong
    // diagnosis, and the one an operator would act on by looking at the model rather than the
    // hang. Holds however the two window lengths compare, which is the point: an operator can
    // configure this window BELOW the inactivity one, where no clamp applies.
    const { watchdog, expirations, speak } = build(20)
    speak()
    const window = watchdog.open()
    await tick(80)
    window.close()
    expect(expirations).toEqual([])
  })

  it('catches a run that goes quiet and then resumes its monologue', async () => {
    // The deferral above re-arms rather than standing down, so a run that comes back talking is
    // still bounded — one full window later.
    const { watchdog, expirations, speak } = build(20)
    const window = watchdog.open()
    await tick(50)
    expect(expirations).toEqual([])
    const chatter = setInterval(speak, 5)
    await tick(60)
    clearInterval(chatter)
    window.close()
    expect(expirations.length).toBeGreaterThan(0)
  })

  it('stops measuring once the stream that opened the window closes it', async () => {
    const { watchdog, expirations, speak } = build(20)
    watchdog.open().close()
    const chatter = setInterval(speak, 5)
    await tick(70)
    clearInterval(chatter)
    expect(expirations).toEqual([])
  })

  it('ignores a superseded window rather than letting it disarm the live one', async () => {
    // A repair loop runs agent passes in sequence. A stale handle reaching back into the
    // watchdog — a late `close()` from the previous pass — would disarm it for the rest of the
    // job, which is silent: nothing fails, the run is simply unwatched from then on.
    const { watchdog, expirations, speak } = build(20)
    const stale = watchdog.open()
    const live = watchdog.open()
    stale.close()
    stale.toolCompleted()
    const chatter = setInterval(speak, 5)
    await tick(60)
    clearInterval(chatter)
    live.close()
    expect(expirations.length).toBeGreaterThan(0)
  })

  it('hands out inert windows when disabled', async () => {
    const { watchdog, expirations, speak } = build(0)
    watchdog.open()
    const chatter = setInterval(speak, 5)
    await tick(60)
    clearInterval(chatter)
    expect(expirations).toEqual([])
  })
})
