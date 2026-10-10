import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The query-parameter primitives every bounded `/api/v1` list shares: the opaque keyset
// cursor, the page limit, an epoch-ms lower bound and a boolean flag.
//
// One module rather than a private copy per contract file, because these ARE the surface's
// pagination contract (`backend/docs/public-api.md`, "Pagination") rather than four
// independent local details: a list whose `limit` ceiling or cursor length drifted from its
// siblings would be a difference a caller discovers by getting a 400 from one endpoint and
// not another. `/jobs`, the task list, the whole `/debug` surface and the Kaizen entries all
// read them from here.
//
// Query params arrive as STRINGS, so each numeric one is digit-checked BEFORE the coercion:
// `Number()` alone also accepts `1e9`, `0x64` and `' '`, which would read as plausible values
// rather than the 400 a malformed request deserves. The `maxValue` ceilings are what make the
// bounds real backstops rather than suggestions (a caller cannot ask for the whole table back
// by passing a huge limit).
// ---------------------------------------------------------------------------

/** Hard ceiling on rows one page may return, wherever a list is paginated. */
export const PUBLIC_MAX_PAGE_LIMIT = 100

/**
 * An OPAQUE keyset pagination cursor. Callers must treat it as a black box and echo it back
 * verbatim — its encoding is an implementation detail (today a base64url `<sortKey>|<id>` pair)
 * that may change. Keyset, not offset: an offset page shifts under concurrent inserts, silently
 * skipping or repeating rows, which is exactly what a polling integration must never see.
 */
export const cursorSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))

/** Rows one page may return (1..{@link PUBLIC_MAX_PAGE_LIMIT}); each list documents its default. */
export const pageLimitSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(PUBLIC_MAX_PAGE_LIMIT),
)

/** An epoch-ms query filter: digits only, for the same reason as {@link pageLimitSchema}. */
export const epochMsQuerySchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number of epoch milliseconds'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(0),
)

/**
 * A boolean query filter, spelled `true` / `false`.
 *
 * A closed picklist rather than "anything that is not `false` is true": on a tri-state filter
 * (omitted / true / false) a typo has to refuse, because coercing `?acknowledged=yes` to `true`
 * would serve a caller the confident opposite of what it asked for on a `false` typo, with no
 * way to notice.
 */
export const booleanQuerySchema = v.pipe(
  v.picklist(['true', 'false']),
  v.transform((value) => value === 'true'),
)
