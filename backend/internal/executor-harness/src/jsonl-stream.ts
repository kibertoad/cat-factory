// BOUNDED reading of an agent CLI's child streams: LF-framing its JSONL stdout, and holding a
// capped tail of raw output for diagnostics.
//
// WHY THIS MODULE EXISTS — the harness's two watchdog timers and its `/health` + `/jobs` poll
// endpoints share ONE Node event loop with the stream-parsing hot path, so the advertised "a
// container can never run forever" guarantee only holds while that loop stays live (stuck-run
// audit F6). Both CLI readers (`runPi`, `runSubscriptionAgent`) had grown the same unbounded
// framing loop: a record with no terminating newline accumulated without limit, so a runaway
// producer could drive the buffer until a single `JSON.parse` (or the allocation behind it)
// stalled the loop past the abort timers and the poll handlers alike. The container then stops
// answering polls while its own watchdogs never fire — the exact wedge the timers exist to
// prevent, with only the engine-side poll-failure tolerance and the reaper left underneath.
//
// One definition of "how much of a child's output we are willing to hold" therefore serves both
// harnesses, for the same reason `ProgressGuard` does: two copies of a bound are two bounds.

/**
 * Longest single JSONL record either CLI may emit before the reader stops buffering it.
 *
 * Deliberately far above the largest LEGITIMATE record — the terminal `agent_end`, which carries
 * the run's whole message transcript including tool results — because dropping that one costs the
 * run its summary and stats. The cap is not a size policy, it is the ceiling that keeps a
 * runaway producer from growing the buffer until parsing it wedges the event loop, so it only
 * has to be low enough that one parse of it stays well inside the poll cadence.
 */
export const MAX_JSONL_LINE_CHARS = 32 * 1024 * 1024

/**
 * A fixed-size tail of a text stream, for output kept ONLY to quote back on a failure.
 *
 * Retaining a whole run's stdout to slice the last 2 KB off it at close is the memory half of
 * F6: a chatty agent's output is unbounded, and the container OOMing is another way for a job to
 * stop answering polls with no watchdog having fired. The tail is trimmed lazily — only once it
 * has grown past twice the bound — so a run that streams thousands of chunks pays an amortized
 * O(1) copy per chunk rather than an O(maxChars) slice on every one of them.
 */
export class BoundedTail {
  private text = ''
  private total = 0

  constructor(private readonly maxChars: number) {}

  push(chunk: string): void {
    this.text += chunk
    this.total += chunk.length
    if (this.text.length > this.maxChars * 2) this.text = this.text.slice(-this.maxChars)
  }

  /** The last `maxChars` characters seen. */
  toString(): string {
    return this.text.length > this.maxChars ? this.text.slice(-this.maxChars) : this.text
  }

  /** Everything ever pushed, whether or not it is still retained. */
  get totalChars(): number {
    return this.total
  }

  /**
   * Characters dropped off the FRONT because the tail is bounded; 0 while everything still fits.
   *
   * A caller that renders the tail to a human owes them this: a bounded tail is the opposite of a
   * prefix, so a reader who assumes one concludes the producer stopped where the text begins.
   * Diagnostic quotes (a stderr tail) need no such note — being a tail is what they are for.
   */
  get droppedChars(): number {
    return this.total - this.toString().length
  }
}

/**
 * Frames a child's LF-delimited JSONL stdout into complete records, bounding what it will buffer
 * for any one of them.
 *
 * `onLine` is invoked per complete record with `final: false`, and once more from {@link flush}
 * with `final: true` for a trailing record that arrived without its newline (a clean exit can
 * leave the last event unterminated). `final` is what lets a caller deliver the record's
 * progress/telemetry signal while suppressing any decision that would KILL the run: the process
 * has already exited, so a guard tripping on that last buffered record would turn a clean exit
 * into a spurious failure.
 *
 * A record that outgrows {@link MAX_JSONL_LINE_CHARS} is DROPPED, not truncated: a partial JSON
 * document is not a record, and handing the parser half of one would report it as corrupt output
 * rather than as the bound firing. The reader then resynchronises on the next newline, so the
 * oversized record costs its own signal and nothing after it. Callers report {@link droppedLines}
 * at close (never per line) so the loss is diagnosable instead of silent.
 */
export class JsonlLineReader {
  private buffer = ''
  /** True while discarding the tail of a record that already blew the cap. */
  private skipping = false
  private dropped = 0

  constructor(
    private readonly onLine: (line: string, final: boolean) => void,
    private readonly maxLineChars: number = MAX_JSONL_LINE_CHARS,
  ) {}

  /** Feed one stdout chunk, emitting every complete record it finishes. */
  push(text: string): void {
    // Framing scans the incoming CHUNK, never the accumulated buffer. `buffer += chunk` is a
    // cheap rope in V8 and `.length` reads off it in constant time, but ANY search over it
    // flattens the rope — so scanning the buffer once per chunk costs O(record) per chunk, i.e.
    // quadratic in a runaway record, paid on the very event loop this class exists to keep
    // answering polls. Measured, a 32 MB unterminated record cost ~6s of solid blocking that
    // way: the cap bounded the memory and handed back the stall in its place.
    let rest = text
    for (;;) {
      const nl = rest.indexOf('\n')
      if (nl === -1) break
      if (this.skipping) {
        // The newline that ends an oversized record ends the skip with it: everything buffered
        // for that record is already gone, and what follows is a fresh one.
        this.skipping = false
      } else {
        // The only place the buffer is materialised, and only for a record that COMPLETED —
        // which the branch below has already kept under the cap.
        const raw = this.buffer + rest.slice(0, nl)
        this.buffer = ''
        // The cap is on the RECORD, not on the leftover buffer: a record that arrived whole
        // inside one chunk was never buffered across pushes, and dropping it only when it
        // straddles a chunk boundary would make the bound depend on how the OS split the reads.
        if (raw.length > this.maxLineChars) this.dropped++
        else this.onLine(raw.trim(), false)
      }
      rest = rest.slice(nl + 1)
    }
    if (this.skipping) return
    this.buffer += rest
    if (this.buffer.length > this.maxLineChars) {
      this.buffer = ''
      // Count the record once, however many chunks it goes on to spill.
      this.dropped++
      this.skipping = true
    }
  }

  /** Emit any trailing unterminated record (see the class doc); call once, after the child exits. */
  flush(): void {
    const line = this.buffer.trim()
    this.buffer = ''
    if (line && !this.skipping) this.onLine(line, true)
  }

  /** Records dropped for exceeding the line cap; 0 on every ordinary run. */
  get droppedLines(): number {
    return this.dropped
  }
}
