import { readdir, stat } from 'node:fs/promises'
import { createReadStream, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import { claudeAssistantContent, claudeCallUsage, isObject, redactBody } from './claude-stream.js'
import type { Logger } from './logger.js'
import type { HarnessCallMetric, TodoProgress } from './pi.js'

// ADR 0026 D2.1 + D3, corrected by ADR 0027. When the Claude Code CLI reviews a large PR
// it fans the work out across parallel `Task` subagents. Two things then go dark to the
// harness, which only reads the PARENT process's stream-json stdout:
//
//  - the parent stream falls quiet for the whole (potentially 15+ minute) parallel
//    review, so the inactivity heartbeat freezes and a healthy run looks wedged (P3);
//  - every subagent's token spend is written to a SEPARATE `subagents/*.jsonl`
//    transcript under the CLI's config home and never reaches the parent stream, so
//    the run's telemetry reports ~0 tokens while hundreds of thousands are spent (P3).
//
// This module closes both without disabling the (context-bounding, ADR-0023-wanted)
// subagent parallelism:
//
//  - {@link createSliceTracker} derives the slice plan + per-slice progress from the
//    PARENT stream alone — the `Task` tool_use dispatch and its terminal tool_result
//    DO appear there (only the subagent's intermediate turns don't), so slices/progress
//    need no file watching (D2.1). {@link pickProgress} reconciles it with any parent
//    TodoWrite plan (ADR 0027 Defect B);
//  - {@link startSubagentWatcher} tails the `subagents/*.jsonl` transcripts for the
//    heartbeat (any new bytes ⇒ `onActivity`) and sums each subagent turn's usage into
//    the run's telemetry (D3).
//
// The CLI does NOT write those transcripts to `<configHome>/subagents` (the location ADR
// 0026 assumed, which never exists — ADR 0027 Defect A). It writes them PER SESSION under
// `<configHome>/projects/<encoded-cwd>/<session-uuid>/subagents/agent-*.jsonl`, and the
// session-uuid dir isn't known before the CLI mints it — so the watcher is pointed at the
// `projects` root and DISCOVERS the `subagents/` dir by walking (see
// {@link findSubagentTranscripts}).
//
// Both degrade gracefully: the CLI's subagent transcript layout is not a stable contract,
// so a missing directory, an unreadable file, or an unparseable line is swallowed and the
// harness falls back to today's parent-stream-only behaviour.

// ---------------------------------------------------------------------------
// Slice / progress tracking off the PARENT stream (D2.1)
// ---------------------------------------------------------------------------

interface TrackedSlice {
  /** The `Task` tool_use id, used to pair the terminal tool_result. */
  toolUseId: string
  /** The subagent's description (`Review <slice> slice`), rendered as the progress label. */
  description: string
  done: boolean
}

/** Tracks parallel `Task` subagents seen on the parent stream to derive slice progress. */
export interface SliceTracker {
  /** Feed an `assistant` message's content blocks: registers any `Task` dispatches. */
  onAssistant(content: unknown[]): void
  /** Feed a `user` message's content blocks: marks the paired subagent(s) complete. */
  onUser(content: unknown[]): void
  /** Whether any `Task` subagent has been dispatched (⇒ this run parallelised). */
  hasSlices(): boolean
  /**
   * Progress derived from the dispatched subagents (completed / in-flight / total),
   * or undefined when none have been dispatched. Reconciled with any parent TodoWrite
   * plan by {@link pickProgress} — it is NOT gated off by the presence of a todo plan
   * (that gate was ADR 0027 Defect B: the pr-reviewer prompt writes the plan ONCE at
   * grouping time and never marks it done, which used to permanently mask this signal).
   */
  progress(): TodoProgress | undefined
}

export function createSliceTracker(): SliceTracker {
  // Insertion-ordered so the progress `items` render in dispatch order.
  const slices = new Map<string, TrackedSlice>()

  return {
    onAssistant(content) {
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_use' || block.name !== 'Task') continue
        const id = typeof block.id === 'string' ? block.id : undefined
        if (!id || slices.has(id)) continue
        const input = isObject(block.input) ? block.input : {}
        const description =
          typeof input.description === 'string' && input.description.trim()
            ? input.description.trim()
            : `Subagent ${slices.size + 1}`
        slices.set(id, { toolUseId: id, description, done: false })
      }
    },
    onUser(content) {
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_result') continue
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
        const slice = id ? slices.get(id) : undefined
        if (slice) slice.done = true
      }
    },
    hasSlices() {
      return slices.size > 0
    },
    progress() {
      if (slices.size === 0) return undefined
      const items = [...slices.values()].map((s) => ({
        label: s.description,
        status: (s.done ? 'completed' : 'in_progress') as 'completed' | 'in_progress',
      }))
      const completed = items.filter((i) => i.status === 'completed').length
      return {
        completed,
        inProgress: items.length - completed,
        total: items.length,
        items,
      }
    },
  }
}

/**
 * Reconcile the two redundant views of the same slice work into the one to surface
 * (ADR 0027 Defect B). A pr-reviewer run has BOTH a parent `TodoWrite` plan (the slices,
 * written once at grouping time) and the {@link SliceTracker}'s `Task`-dispatch view. The
 * sequential shape advances the todo plan; the parallel-subagent shape advances ONLY the
 * slice tracker (the CLI writes the plan once and never marks it done, while the parallel
 * `Task`s report in-flight/complete). Neither alone covers both shapes, and gating the
 * slice tracker OFF whenever a todo plan exists (the old behaviour) pinned parallel runs
 * at 0%. So prefer whichever view is further along: more `completed`, then more
 * `inProgress` (an all-pending todo plan must not beat live in-flight slices), then more
 * `total` (the richer view — the todo plan can carry an extra "aggregate" entry), else the
 * todo plan. Pure + total; returns whichever single input is present when only one is.
 */
export function pickProgress(
  todo: TodoProgress | undefined,
  slice: TodoProgress | undefined,
): TodoProgress | undefined {
  if (!todo) return slice
  if (!slice) return todo
  if (slice.completed !== todo.completed) return slice.completed > todo.completed ? slice : todo
  if (slice.inProgress !== todo.inProgress) return slice.inProgress > todo.inProgress ? slice : todo
  if (slice.total !== todo.total) return slice.total > todo.total ? slice : todo
  return todo
}

// ---------------------------------------------------------------------------
// Subagent transcript watcher (heartbeat + usage) (D3)
// ---------------------------------------------------------------------------

/** Default poll cadence for the transcript directory; well under the git timeout margin. */
const DEFAULT_POLL_MS = 3_000

export interface SubagentWatcherOptions {
  /** Fed the heartbeat when a transcript grows, so the inactivity watchdog sees the run is alive. */
  onActivity?: () => void
  /** Leased-credential strings to scrub from captured bodies (the transcripts can echo the token). */
  secrets?: string[]
  /** Fallback model id stamped on a subagent call whose transcript omits one. */
  model?: string
  /** Poll cadence (ms); overridable for tests. */
  intervalMs?: number
  log?: Logger
}

export interface SubagentWatcher {
  /** Do a final poll, then stop watching. Idempotent; never throws. */
  stop(): Promise<void>
  /** Cumulative subagent usage lifted so far (input + output tokens). */
  usage(): { inputTokens: number; outputTokens: number }
  /** The per-call telemetry rows lifted from the subagent transcripts so far. */
  calls(): HarnessCallMetric[]
}

/**
 * Recursively collect every `*.jsonl` file that lives inside a `subagents/` directory
 * anywhere under `root` (the CLI's `<configHome>/projects` tree). The Claude CLI writes
 * each parallel `Task` subagent's transcript to
 * `<configHome>/projects/<encoded-cwd>/<session-uuid>/subagents/agent-*.jsonl`; the
 * session-uuid dir isn't known before the CLI mints it, so we DISCOVER the `subagents/`
 * dir by walking rather than guessing its path (ADR 0027 Defect A). Files NOT under a
 * `subagents/` dir — critically the parent's own `<session-uuid>.jsonl` session transcript,
 * whose per-turn usage the terminal `result` event already totals — are deliberately
 * excluded: reading them would double-count the parent. `root` itself counts as inside a
 * `subagents/` dir when its own basename is `subagents` (so passing the leaf dir works too).
 * Best-effort: an unreadable directory is skipped, never thrown.
 */
async function findSubagentTranscripts(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, inSubagents: boolean): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // dir not created yet (or vanished) — try again next tick
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, inSubagents || entry.name === 'subagents')
      } else if (inSubagents && entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full)
      }
    }
  }
  await walk(root, basename(root) === 'subagents')
  return out
}

/**
 * Start watching `root` (the CLI's `<configHome>/projects` tree) for subagent `*.jsonl`
 * transcripts — any file under a `subagents/` directory beneath it (see
 * {@link findSubagentTranscripts}) — tailing each file by byte offset. New content feeds
 * `onActivity` (heartbeat) and each assistant turn carrying usage is lifted into a
 * {@link HarnessCallMetric} + summed into the cumulative usage. Best-effort throughout: the
 * tree may not exist yet (created lazily by the CLI), a file may be mid-write, and the
 * line/usage shape may change across CLI versions — every such case is swallowed so the
 * watcher can only ever ADD signal, never break the run.
 */
export function startSubagentWatcher(root: string, opts: SubagentWatcherOptions): SubagentWatcher {
  const secrets = opts.secrets ?? []
  const offsets = new Map<string, number>()
  const calls: HarnessCallMetric[] = []
  const usage = { inputTokens: 0, outputTokens: 0 }
  // Per-file partial-line remainder, carried as raw BYTES (not a decoded string). A JSONL
  // record can straddle two polls (the file is appended between ticks), and the byte offset
  // we stop at can fall in the middle of a multi-byte UTF-8 character; decoding a partial
  // read to a string would replace that split character with U+FFFD and corrupt the line.
  // Buffering bytes and decoding only whole lines keeps the captured text faithful.
  const carry = new Map<string, Buffer>()
  let polling = false

  const ingestLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }
    // Subagent transcripts mirror the session-transcript envelope: an `assistant` entry
    // whose `message` carries the Anthropic `usage` + `content`. Read defensively.
    if (event.type !== 'assistant' || !isObject(event.message)) return
    const message = event.message as Record<string, unknown>
    const u = claudeCallUsage(message.usage)
    if (u.inputTokens === 0 && u.outputTokens === 0) return
    const content = Array.isArray(message.content) ? message.content : []
    const { text, reasoning } = claudeAssistantContent(content)
    calls.push({
      ...(typeof message.model === 'string'
        ? { model: message.model }
        : opts.model
          ? { model: opts.model }
          : {}),
      // The subagent's own transcript isn't a re-sendable prompt chain, so we don't
      // reconstruct the request side (kept empty); the response + tokens are faithful.
      promptText: '',
      messageCount: 0,
      responseText: redactBody(text, secrets),
      reasoningText: redactBody(reasoning, secrets),
      inputTokens: u.inputTokens,
      cachedInputTokens: u.cachedInputTokens,
      outputTokens: u.outputTokens,
      finishReason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
    })
    usage.inputTokens += u.inputTokens
    usage.outputTokens += u.outputTokens
  }

  const NEWLINE = 0x0a
  const readNew = (path: string, from: number, to: number): Promise<void> =>
    new Promise((resolve) => {
      // Tail as raw bytes and split on the newline byte, decoding each COMPLETE line to
      // UTF-8 only on that boundary (a '\n' is a single byte, never part of a multi-byte
      // sequence), so a record — or a multi-byte character — that spans this read and the
      // next is reassembled from the byte carry rather than corrupted at the seam.
      let buffer = carry.get(path) ?? Buffer.alloc(0)
      const stream = createReadStream(path, { start: from, end: to - 1 })
      stream.on('data', (chunk: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
        let nl = buffer.indexOf(NEWLINE)
        while (nl !== -1) {
          ingestLine(buffer.subarray(0, nl).toString('utf8'))
          buffer = buffer.subarray(nl + 1)
          nl = buffer.indexOf(NEWLINE)
        }
      })
      stream.on('error', () => resolve())
      stream.on('close', () => {
        // Copy the remainder out of the shared chunk backing store before caching it, so a
        // later Buffer.concat can't be aliased by a reused stream buffer.
        carry.set(path, Buffer.from(buffer))
        resolve()
      })
    })

  const pollOnce = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
      let grew = false
      for (const path of await findSubagentTranscripts(root)) {
        let size: number
        try {
          size = (await stat(path)).size
        } catch {
          continue
        }
        const from = offsets.get(path) ?? 0
        if (size <= from) continue
        grew = true
        await readNew(path, from, size)
        offsets.set(path, size)
      }
      if (grew) opts.onActivity?.()
    } catch (e) {
      opts.log?.warn('subagent transcript poll failed', { error: String(e) })
    } finally {
      polling = false
    }
  }

  const timer = setInterval(() => void pollOnce(), opts.intervalMs ?? DEFAULT_POLL_MS)
  // Don't let the watcher's timer keep the container process alive on its own.
  timer.unref?.()

  return {
    // Always does a final drain (idempotent clear of the timer), so a late transcript
    // write between the last tick and stop is still captured, and a second stop() picks up
    // anything appended since — the per-file offsets make re-polling safe (no double count).
    async stop() {
      clearInterval(timer)
      await pollOnce()
    },
    usage() {
      return { ...usage }
    },
    calls() {
      return calls
    },
  }
}
