// The tool-silence watchdog (stuck-run audit F13): the third bound on a job, and the only one
// that can see a model which keeps TALKING while completing nothing. Its output resets the
// inactivity timer on every chunk, and it is nowhere near the wall-clock cap.
//
// WHY THIS IS ITS OWN MODULE — the window is only meaningful while something that REPORTS
// completed tool calls is running, and only that producer knows whether it does. Keying the
// window on the job's coarse phase label instead looked equivalent and was not: `agent` is a
// telemetry breadcrumb several call sites mark for several different things (a Codex pass, a
// tool-less inline completion, the label restored around a repair loop's shell commands), so a
// phase-armed window spent most of its time armed over work that could not possibly reset it.
// The producer opens its own window instead, which makes "armed" and "can beat" the same fact by
// construction rather than by two call sites agreeing.

/**
 * The live window for ONE tool-reporting agent stream. Opened by the stream, beaten by each
 * completed tool call, closed when the stream ends (cleanly or not) — so the window can never
 * outlive the only thing able to reset it.
 */
export interface ToolProgressWindow {
  /** A tool call completed: the only evidence this watchdog accepts as progress. */
  toolCompleted(): void
  /** The stream ended; the window closes with it. Idempotent. */
  close(): void
}

/**
 * A window that measures nothing: what the watchdog hands out when disabled, and what a producer
 * substitutes when its caller wired no watchdog at all. Having one means every producer holds a
 * real window and states its tool progress unconditionally, rather than guarding each call site
 * with a `?.` that reads as though beating the window were optional.
 */
export const NO_TOOL_WINDOW: ToolProgressWindow = { toolCompleted: () => {}, close: () => {} }

export interface ToolSilenceDeps {
  /** The window length. `<= 0` disables the watchdog entirely (every window is inert). */
  windowMs: number
  /**
   * When the run last produced ANY output, or undefined if it never has — the same clock the
   * inactivity watchdog resets on. Read at EXPIRY (see {@link ToolSilenceWatchdog.open}), which
   * is what keeps this watchdog off the gone-quiet case.
   */
  lastActivityAt: () => number | undefined
  /** Called when a window expires with the run demonstrably still talking. */
  onExpired: () => void
}

/**
 * Hands out {@link ToolProgressWindow}s and fires `onExpired` for one that goes a full window
 * without a completed tool call while the run keeps producing output.
 *
 * ONE window is open at a time (a job runs one agent stream at a time, and a repair loop runs
 * them in sequence). Opening a second supersedes the first, and a superseded handle's calls are
 * ignored rather than reaching back into the live window — a stale `close()` from a stream that
 * finished after its successor started would otherwise disarm the watchdog for the rest of the job.
 */
export class ToolSilenceWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Identity of the window currently open; every handout takes the next number. */
  private openId = 0
  /** When the live window was last armed — the start of the span `onExpired` is a verdict about. */
  private armedAt = 0

  constructor(private readonly deps: ToolSilenceDeps) {}

  /** Open a window for one agent stream. Returns an inert handle when the watchdog is disabled. */
  open(): ToolProgressWindow {
    if (this.deps.windowMs <= 0) return NO_TOOL_WINDOW
    const id = ++this.openId
    this.arm()
    const live = (): boolean => this.openId === id
    return {
      toolCompleted: () => {
        if (live()) this.arm()
      },
      close: () => {
        if (!live()) return
        // Retire the id as well as the timer, so a late `toolCompleted()` from this stream
        // cannot re-arm a window whose producer has already gone.
        this.openId++
        this.stop()
      },
    }
  }

  /** Disarm for good (the job settled). Safe to call with no window open. */
  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    clearTimeout(this.timer)
    this.armedAt = Date.now()
    this.timer = setTimeout(() => this.expire(), this.deps.windowMs)
  }

  /**
   * A window elapsed with no completed tool call. Fire ONLY if the run was talking through it.
   *
   * `no-tool-progress` claims something specific — output arrived, but nothing got done — and
   * that is only a truthful reading when output actually arrived DURING the window that just
   * expired. A window that passed in total silence is the INACTIVITY watchdog's fact, whose
   * diagnostic ("the container went quiet") is the one an operator can act on; relabelling it as
   * a rabbit-hole would send them looking at the model instead of at the hang.
   *
   * This is a structural guard, not a tie-breaker: the two timers anchor on different events (the
   * last tool call vs the last byte of output), so no arithmetic between the two window LENGTHS
   * can order them. Equal windows put the tool-silence anchor strictly earlier — it fires first —
   * and an operator setting `JOB_TOOL_SILENCE_MS` below `JOB_INACTIVITY_MS` gets that on every
   * quiet run. Deciding from what the expired window actually SAW is independent of both numbers.
   *
   * A deferred window re-arms rather than standing down, so a run that goes quiet and then
   * resumes its monologue is still caught, one full window later. The deferral terminates:
   * either output resumes (the next expiry has output in its window and fires) or it does not
   * (inactivity fires).
   */
  private expire(): void {
    const lastActivityAt = this.deps.lastActivityAt()
    if (lastActivityAt === undefined || lastActivityAt <= this.armedAt) {
      this.arm()
      return
    }
    this.deps.onExpired()
  }
}
