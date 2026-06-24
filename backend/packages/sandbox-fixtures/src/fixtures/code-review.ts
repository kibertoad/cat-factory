import { exp } from '../expectation.js'
import type { SandboxFixtureDefinition } from '../types.js'

// reviewer (code-review) fixtures. The payload is a reviewer `AgentRunContext`: the work
// to review is carried as the `coder` step's entry in `priorOutputs` (a code snippet in a
// fenced block). The expectations are the genuine correctness/security/edge-case problems a
// strong reviewer should find, graded by impact (how bad to miss) and trickiness (how subtle).

/** Build a reviewer context whose only prior output is the coder's snippet to review. */
function reviewerContext(
  block: { title: string; type: string; description: string },
  snippet: string,
): Record<string, unknown> {
  return {
    agentKind: 'reviewer',
    pipelineName: 'sandbox',
    stepIndex: 1,
    isFinalStep: true,
    block,
    priorOutputs: [{ agentKind: 'coder', output: snippet }],
    decisions: [],
    resolvedDecision: null,
  }
}

export const CODE_REVIEW_FIXTURES: SandboxFixtureDefinition[] = [
  {
    id: 'review-token-bucket-simple',
    agentKind: 'reviewer',
    kind: 'code-review',
    name: 'Rate limiter (simple)',
    difficulty: 'simple',
    summary: 'A "token bucket" rate limiter that is neither a token bucket nor concurrency-safe.',
    payload: reviewerContext(
      {
        title: 'Per-IP rate limiter',
        type: 'api',
        description:
          'A token-bucket rate limiter middleware that allows 100 requests/minute per IP.',
      },
      [
        'Implemented the limiter:',
        '',
        '```ts',
        'const counts = new Map<string, number>()',
        '',
        'export function allow(ip: string): boolean {',
        '  const count = counts.get(ip) ?? 0',
        '  if (count >= 100) return false',
        '  counts.set(ip, count + 1)',
        '  return true',
        '}',
        '```',
        '',
        'The counter increments on each request and rejects once it hits 100.',
      ].join('\n'),
    ),
    expectations: [
      exp(
        'no-window-reset',
        'There is no time window: the count never resets, so this is a lifetime cap of 100, not 100/minute.',
        {
          impact: 5,
          trickiness: 3,
          detail:
            'The headline bug — the feature simply does not do what the spec ("per minute") asks.',
          matchHints: [
            'never resets',
            'no window',
            'time window',
            'per minute',
            'lifetime',
            'does not reset',
          ],
        },
      ),
      exp(
        'unbounded-map',
        'The Map grows unbounded (one entry per IP, never evicted) — a memory leak / DoS vector.',
        {
          impact: 4,
          trickiness: 3,
          matchHints: ['unbounded', 'memory leak', 'never evicted', 'grows', 'grow forever'],
        },
      ),
      exp(
        'concurrency',
        'Read-modify-write on the shared Map is not atomic; concurrent requests can over-admit.',
        {
          impact: 3,
          trickiness: 4,
          matchHints: ['atomic', 'race', 'concurrent', 'read-modify-write', 'thread'],
        },
      ),
    ],
    notes:
      'The missing time-window reset is the high-impact must-find; the concurrency hazard is the subtler catch.',
  },
  {
    id: 'review-pagination-moderate',
    agentKind: 'reviewer',
    kind: 'code-review',
    name: 'Offset pagination (moderate)',
    difficulty: 'moderate',
    summary: 'A list endpoint with SQL injection, unbounded page size, and an off-by-one.',
    payload: reviewerContext(
      {
        title: 'List orders endpoint',
        type: 'api',
        description:
          'GET /orders?page=&size= returns a page of the current user’s orders, newest first.',
      },
      [
        'Added the handler:',
        '',
        '```ts',
        'async function listOrders(req) {',
        '  const page = req.query.page ?? 1',
        '  const size = req.query.size ?? 20',
        '  const offset = page * size',
        '  const sql =',
        '    `SELECT * FROM orders WHERE user_id = ${req.userId} ORDER BY created_at DESC ` +',
        '    `LIMIT ${size} OFFSET ${offset}`',
        '  return db.query(sql)',
        '}',
        '```',
      ].join('\n'),
    ),
    expectations: [
      exp(
        'sql-injection',
        'Values are interpolated straight into SQL — `size`, `page`, and `userId` must be parameterized.',
        {
          impact: 5,
          trickiness: 1,
          detail: 'Classic SQL injection; the most impactful and least subtle issue here.',
          matchHints: [
            'sql injection',
            'parameterize',
            'parameterized',
            'interpolat',
            'prepared statement',
          ],
        },
      ),
      exp(
        'offset-off-by-one',
        'Offset is `page * size`, so page 1 skips the first page; it should be `(page - 1) * size`.',
        {
          impact: 4,
          trickiness: 4,
          detail: 'A subtle correctness bug: with 1-based pages, page 1 already skips `size` rows.',
          matchHints: [
            'off-by-one',
            'off by one',
            'page - 1',
            'page minus one',
            'skips the first',
            'should be (page',
          ],
        },
      ),
      exp(
        'unbounded-size',
        'No upper bound on `size`: a client can request a huge page and exhaust memory / the DB.',
        {
          impact: 4,
          trickiness: 3,
          matchHints: ['unbounded', 'max size', 'cap the', 'upper bound', 'limit the page size'],
        },
      ),
      exp(
        'query-types',
        'Query params are strings: `page`/`size` are not parsed to numbers and not validated as positive integers.',
        {
          impact: 3,
          trickiness: 3,
          matchHints: ['string', 'parse', 'not a number', 'validate', 'integer', 'nan'],
        },
      ),
    ],
    notes:
      'SQL injection is the must-find; the `page * size` off-by-one is the high-trickiness catch.',
  },
  {
    id: 'review-jwt-verify-complex',
    agentKind: 'reviewer',
    kind: 'code-review',
    name: 'JWT verification (complex)',
    difficulty: 'complex',
    summary: 'A hand-rolled JWT verifier with several serious, subtle security holes.',
    payload: reviewerContext(
      {
        title: 'Verify session JWT',
        type: 'service',
        description: 'Verify an incoming JWT and return its claims, rejecting invalid tokens.',
      },
      [
        'Implemented verification:',
        '',
        '```ts',
        'function verify(token: string, secret: string) {',
        '  const [headerB64, payloadB64, sig] = token.split(".")',
        '  const header = JSON.parse(atob(headerB64))',
        '  const payload = JSON.parse(atob(payloadB64))',
        '  if (header.alg === "none") return payload',
        '  const expected = hmacSha256(`${headerB64}.${payloadB64}`, secret)',
        '  if (sig === expected) {',
        '    return payload',
        '  }',
        '  throw new Error("bad token")',
        '}',
        '```',
      ].join('\n'),
    ),
    expectations: [
      exp(
        'alg-none',
        'It accepts `alg: "none"` and returns the payload unverified — anyone can forge a token.',
        {
          impact: 5,
          trickiness: 5,
          detail:
            'The canonical JWT "alg=none" bypass; the most dangerous and most impressive catch.',
          matchHints: [
            'alg none',
            'alg: none',
            'algorithm none',
            'none algorithm',
            'forge',
            'unverified',
          ],
        },
      ),
      exp(
        'no-exp',
        'No expiry (`exp`)/`nbf` check, so an old or stolen token is accepted forever.',
        {
          impact: 5,
          trickiness: 2,
          matchHints: ['expiry', 'expiration', 'exp claim', 'expired', 'nbf', 'not before'],
        },
      ),
      exp(
        'timing-unsafe',
        'Signature compared with `===` (timing-unsafe); use a constant-time comparison.',
        {
          impact: 3,
          trickiness: 4,
          detail: 'A timing side-channel on signature comparison — a hallmark of an expert review.',
          matchHints: ['timing', 'constant-time', 'constant time', 'timing-safe', 'timing attack'],
        },
      ),
      exp(
        'alg-confusion',
        'Header `alg` is trusted but only HMAC is computed — an RS256→HS256 key-confusion attack is possible.',
        {
          impact: 4,
          trickiness: 5,
          detail: 'The classic JWT algorithm-confusion class; rarely surfaced.',
          matchHints: ['algorithm confusion', 'alg confusion', 'rs256', 'hs256', 'key confusion'],
        },
      ),
      exp(
        'audience-issuer',
        'No `aud`/`iss` validation, so a token minted for another service is accepted.',
        {
          impact: 3,
          trickiness: 3,
          matchHints: ['audience', 'aud claim', 'issuer', 'iss claim'],
        },
      ),
    ],
    notes:
      'A dense security review: alg=none and algorithm-confusion are the high-trickiness wow catches; alg=none and missing-exp are the high-impact must-finds.',
  },
]
