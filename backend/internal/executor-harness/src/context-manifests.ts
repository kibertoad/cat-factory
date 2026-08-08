// ---------------------------------------------------------------------------
// The two manifests of FILES the backend stages into a checkout before the agent's first turn:
// the linked-context documents it materialises under CONTEXT_DIR, and the reference design images
// it has the harness download beside them.
//
// One module because they are the same kind of thing parsed the same defensive way, and because
// they share the basename rule below: both name files the container writes into a directory it
// then points the agent at, so both are held to a value that cannot escape it or clobber a repo
// file. Split out of `job.ts`, which parses everything else a job body carries.
// ---------------------------------------------------------------------------

/**
 * A linked-context file the backend prepared (requirements / RFC / PRD / tracker issue)
 * for the harness to materialise under CONTEXT_DIR in the checkout, so the agent can read
 * it on demand. The harness can't reach Jira/GitHub itself, so all such context is fetched
 * and shipped here up front. `path` is sanitised to a safe basename on parse.
 */
export interface ContextFileSpec {
  path: string
  title: string
  url: string
  content: string
}

/**
 * The REFERENCE DESIGN IMAGES the backend holds for this task, for the harness to download into
 * `.cat-context/reference-screenshots/` before the agent runs: the directory a UI tester's prompt
 * names and, until now, nothing wrote.
 *
 * A manifest rather than the bytes: a design frame is a full-page PNG, and a job body is JSON
 * that crosses every transport and is persisted with the dispatch. The bytes come back over the
 * SAME container session token the run already holds (`GET ${url}/<artifactId>`), so this needs
 * no extra credential and no publicly reachable URL.
 *
 * `view` is what the backend's gate pairs on, and `fileName` is the name the BACKEND chose for it,
 * never derived here. The file name is how the agent learns the view name, so deriving it in the
 * container would let a harness image the deployment has not rolled out yet rename every view a
 * run reports, and the pairing would come apart with nothing failing.
 */
export interface ReferenceScreenshotsSpec {
  /** Base URL of the reference download route; the artifact id is appended as a path segment. */
  url: string
  /** The run's container session token (the same one the LLM proxy is called with). */
  token: string
  files: ReferenceScreenshotSpec[]
  /**
   * View names the task holds a reference for that this job was NOT sent a file for, because the
   * set was capped. Stated to the agent beside the transfers that failed: from where it stands
   * both are a view to capture with no image to compare against.
   *
   * Two producers, and they mean the same thing here: the BACKEND's own ceiling (the number that
   * should ever actually bind, chosen where the precedence between an upload and a design frame
   * is known), and this parser's backstop against a body claiming more files than any real set
   * has. A drop with no entry here is the bug this field exists to prevent.
   */
  omitted: string[]
}

/** One reference image in a {@link ReferenceScreenshotsSpec}. `fileName` is sanitised on parse. */
export interface ReferenceScreenshotSpec {
  artifactId: string
  fileName: string
  view: string
}

/**
 * Sanitise a body-supplied context filename to a safe basename within CONTEXT_DIR:
 * strip any directory part, allow only `[A-Za-z0-9._-]`, and reject empties / dotfiles
 * / `..` so a hostile value can't escape the directory or clobber repo files.
 */
export function sanitizeContextFileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const base = value.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return undefined
  return cleaned
}

/** Parse the linked-context files, dropping any malformed/unsafe entry. */
export function parseContextFiles(value: unknown): ContextFileSpec[] {
  if (!Array.isArray(value)) return []
  const files: ContextFileSpec[] = []
  const used = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const path = sanitizeContextFileName(e.path)
    if (!path || used.has(path)) continue
    if (typeof e.content !== 'string') continue
    used.add(path)
    files.push({
      path,
      title: typeof e.title === 'string' ? e.title : path,
      url: typeof e.url === 'string' ? e.url : '',
      content: e.content,
    })
  }
  return files
}

/**
 * How many reference images one job may be handed. The backend caps the set it sends well below
 * this, so this is the harness's own backstop against a malformed or hostile body turning the
 * pre-run setup into an unbounded download, never the ceiling a real run meets.
 *
 * Hitting it is REPORTED rather than silently obeyed: an entry past the ceiling is dropped from
 * `files` and its view named on `omitted`, so an agent facing a truncated set is still told which
 * views to capture. A cap that shortened the list and said nothing would be indistinguishable, on
 * disk and in the prompt, from a design that simply has no such screen.
 */
const MAX_REFERENCE_SCREENSHOTS = 40

/**
 * Parse the reference-design manifest, or undefined when absent/unusable.
 *
 * The whole manifest is dropped when its transport half is unusable (no absolute http(s) URL, no
 * token): every file would fail the same way, and one stated cause beats N identical ones. An
 * individual entry is dropped only when it cannot name a file safely: the same basename
 * sanitisation every context file gets, so a hostile `fileName` can neither escape the directory
 * nor clobber a repo file.
 */
export function parseReferenceScreenshots(value: unknown): ReferenceScreenshotsSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const url = typeof o.url === 'string' ? o.url.trim() : ''
  const token = typeof o.token === 'string' ? o.token : ''
  if (!url || !token || !/^https?:\/\//i.test(url)) return undefined
  if (!Array.isArray(o.files)) return undefined
  const files: ReferenceScreenshotSpec[] = []
  // The backend's own dropped views come first; anything this parser drops joins them below.
  const omitted = Array.isArray(o.omitted)
    ? o.omitted.filter((view): view is string => typeof view === 'string' && view.length > 0)
    : []
  const used = new Set<string>()
  for (const entry of o.files) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const fileName = sanitizeContextFileName(e.fileName)
    const artifactId = typeof e.artifactId === 'string' ? e.artifactId.trim() : ''
    // The id becomes a path segment on the download URL, so it is held to the shape the platform
    // mints rather than encoded and hoped for: anything else cannot be a real artifact anyway.
    if (!fileName || used.has(fileName) || !/^[A-Za-z0-9_-]{1,64}$/.test(artifactId)) continue
    const view = typeof e.view === 'string' ? e.view : fileName
    // Past the backstop the entry is NAMED, not dropped: it stays a view the agent must capture.
    // Checked here rather than at the top of the loop so a malformed entry is refused on its own
    // terms (it names no usable view to report) instead of being counted against the ceiling.
    if (files.length >= MAX_REFERENCE_SCREENSHOTS) {
      omitted.push(view)
      continue
    }
    used.add(fileName)
    files.push({ artifactId, fileName, view })
  }
  if (!files.length && !omitted.length) return undefined
  return { url: url.replace(/\/+$/, ''), token, files, omitted }
}
