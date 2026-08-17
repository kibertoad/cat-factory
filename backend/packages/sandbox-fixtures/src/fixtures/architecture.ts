import { exp } from '../expectation.js'
import type { SandboxFixtureDefinition } from '../types.js'

// architecture-proposal review fixtures. Mapped to the `architect-companion` agent (it
// reviews an `architect`'s design). The proposal under review is carried as the `architect`
// step's entry in `priorOutputs`; the companion critiques it. The expectations are the
// scaling/consistency/operability gaps a strong design review should raise.

/** Build an architect-companion context whose prior output is the design proposal to review. */
function proposalContext(
  block: { title: string; type: string; description: string },
  proposal: string,
): Record<string, unknown> {
  return {
    agentKind: 'architect-companion',
    pipelineName: 'sandbox',
    stepIndex: 1,
    isFinalStep: true,
    block,
    priorOutputs: [{ agentKind: 'architect', output: proposal }],
    decisions: [],
    resolvedDecision: null,
  }
}

export const ARCHITECTURE_FIXTURES: SandboxFixtureDefinition[] = [
  {
    // The simple anchor of the range. Its flaw is not subtle, which is the point: a reviewer that
    // cannot name "local disk is not durable on a fleet" has nothing useful to say about the
    // outbox fixture either, and a rubric needs a floor as much as a ceiling.
    id: 'arch-avatar-storage-simple',
    agentKind: 'architect-companion',
    kind: 'architecture',
    name: 'Avatar storage design (simple)',
    difficulty: 'simple',
    summary: 'An "upload a profile picture" design that stores files on the app server’s own disk.',
    payload: proposalContext(
      {
        title: 'Profile pictures',
        type: 'service',
        description: 'Let a user upload a profile picture and show it beside their name.',
      },
      [
        '# Design: profile pictures',
        '',
        'The upload endpoint writes the file to `/var/app/uploads/<userId>.png` on the API server and',
        'stores the path in `users.avatar_path`. A GET endpoint reads the file off disk and streams it',
        'back. We run three API instances behind the load balancer. Simple and no new dependencies.',
      ].join('\n'),
    ),
    expectations: [
      exp(
        'not-shared-or-durable',
        'Local disk is neither shared across the three instances nor durable across a deploy: an upload lands on one box and 404s from the other two.',
        {
          impact: 5,
          trickiness: 2,
          detail:
            'The central flaw. The design even states the instance count, so the contradiction is on ' +
            'the page; object storage or a shared volume is the fix.',
          matchHints: [
            'three instances',
            'other instance',
            'not shared',
            'local disk',
            'ephemeral',
            'object storage',
            's3',
            'lost on deploy',
            'durab*',
          ],
        },
      ),
      exp(
        'no-upload-validation',
        'No size limit, content-type check or re-encode: the endpoint accepts any file of any size under a `.png` name.',
        {
          impact: 4,
          trickiness: 2,
          matchHints: [
            'size limit',
            'max size',
            'content type',
            'content-type',
            'validate',
            're-encode',
            'image type',
            'arbitrary file',
          ],
        },
      ),
      exp(
        'path-from-user-id',
        'The filename is derived from a request-supplied id, so path traversal and overwriting another user’s avatar both need checking.',
        {
          impact: 4,
          trickiness: 4,
          detail:
            'Whether `userId` is the authenticated user or a parameter decides whether this is a ' +
            'file-overwrite primitive; the design does not say, and a strong review asks.',
          matchHints: [
            'path traversal',
            'travers*',
            'overwrite',
            'authenticated user',
            'sanitis*',
            'sanitiz*',
            'another user',
          ],
        },
      ),
      exp(
        'serving-through-the-app',
        'Streaming every avatar through the API ties image traffic to application capacity; a CDN or signed URL decouples them.',
        {
          impact: 2,
          trickiness: 3,
          matchHints: ['cdn', 'signed url', 'presigned', 'cache', 'static', 'through the app'],
        },
      ),
      exp(
        'no-lifecycle',
        'Nothing removes the file when the user changes or deletes their avatar, or when the account is deleted.',
        {
          impact: 3,
          trickiness: 4,
          matchHints: [
            'delete',
            'cleanup',
            'clean up',
            'orphan',
            'replace',
            'lifecycle',
            'retention',
          ],
        },
      ),
    ],
    notes:
      'The floor of the range. The must-find is the fleet/durability contradiction; the traversal ' +
      'and lifecycle questions separate a competent review from a checklist.',
  },
  {
    id: 'arch-counter-redis-moderate',
    agentKind: 'architect-companion',
    kind: 'architecture',
    name: 'View-counter design (moderate)',
    difficulty: 'moderate',
    summary: 'A "count page views" design that ignores cache durability and write contention.',
    payload: proposalContext(
      {
        title: 'Page view counter',
        type: 'service',
        description: 'Show a near-real-time view count on each article.',
      },
      [
        '# Design: page view counter',
        '',
        'On each request we INCR a Redis key `views:{articleId}` and read it back to render the count.',
        'A background job copies the Redis counts into the `articles.view_count` column every hour so the',
        'numbers survive. Redis runs as a single instance. This is simple and fast.',
      ].join('\n'),
    ),
    expectations: [
      exp(
        'cache-durability',
        'Redis is the source of truth between hourly flushes — a single-instance crash loses up to an hour of counts.',
        {
          impact: 5,
          trickiness: 3,
          detail:
            'Single Redis + hourly persistence makes a cache the durable store; the central design flaw.',
          matchHints: [
            'lose counts',
            'lose up to',
            'data loss',
            'durability',
            'redis crash',
            'single instance',
            'single point of failure',
            'persistence',
          ],
        },
      ),
      exp(
        'hot-key',
        'A viral article is a single hot Redis key — a write/throughput hotspot with no sharding plan.',
        {
          impact: 3,
          trickiness: 4,
          matchHints: ['hot key', 'hotspot', 'hot spot', 'contention', 'shard*'],
        },
      ),
      exp(
        'read-cost',
        'Reading the count back from Redis on every render is unnecessary; the count can be returned from the INCR or cached.',
        {
          impact: 2,
          trickiness: 3,
          matchHints: ['read back', 'every render', 'return from incr', 'extra round trip'],
        },
      ),
      exp(
        'idempotency',
        'No dedupe: refresh/bots inflate counts — is a "view" unique per user/session, and over what window?',
        {
          impact: 3,
          trickiness: 4,
          detail:
            'Whether a view is deduped is a real product/correctness question the design skips.',
          matchHints: ['dedupe', 'deduplicat*', 'unique', 'bot', 'refresh', 'idempoten*'],
        },
      ),
    ],
    notes:
      'The cache-as-durable-store flaw is the must-find; hot-key and dedupe are the higher-skill catches.',
  },
  {
    id: 'arch-outbox-events-complex',
    agentKind: 'architect-companion',
    kind: 'architecture',
    name: 'Order-events pipeline (complex)',
    difficulty: 'complex',
    summary: 'An event-publishing design with a dual-write, at-least-once, and ordering pitfalls.',
    payload: proposalContext(
      {
        title: 'Publish order events',
        type: 'service',
        description:
          'When an order changes, publish an event other services consume (fulfilment, analytics, email).',
      },
      [
        '# Design: order event publishing',
        '',
        'In the order service, after we commit the order to Postgres we publish an `OrderChanged` event to',
        'Kafka. Consumers (fulfilment, analytics, email) subscribe and react. If publishing fails we log it',
        'and retry in a background sweep. Each event carries the full order. We use a topic per event type and',
        'partition by event type so throughput is high.',
      ].join('\n'),
    ),
    expectations: [
      exp(
        'dual-write',
        'Commit-then-publish is a dual write: a crash between the two loses the event despite a committed order — needs a transactional outbox / CDC.',
        {
          impact: 5,
          trickiness: 5,
          detail:
            'The headline distributed-systems flaw and the standout catch — "we commit then publish" is the tell.',
          matchHints: [
            'dual write',
            'dual-write',
            'outbox',
            'cdc',
            'change data capture',
            'commit then publish',
            'two-phase',
          ],
        },
      ),
      exp(
        'ordering',
        'Partitioning by event TYPE (not order id) means events for one order can be processed out of order.',
        {
          impact: 5,
          trickiness: 5,
          detail:
            'Partition key is the subtle but critical choice; per-type partitioning destroys per-order ordering.',
          matchHints: [
            'out of order',
            'ordering',
            'partition by',
            'partition key',
            'per-order',
            'order id key',
          ],
        },
      ),
      exp(
        'idempotent-consumers',
        'At-least-once delivery + retries means consumers must be idempotent — the email service will double-send otherwise.',
        {
          impact: 4,
          trickiness: 3,
          matchHints: [
            'idempoten*',
            'at least once',
            'at-least-once',
            'duplicate',
            'double-send',
            'exactly once',
          ],
        },
      ),
      exp(
        'full-payload',
        'Carrying the full order in every event couples consumers to the order schema and bloats the topic; consider a thin event + lookup or a versioned schema.',
        {
          impact: 3,
          trickiness: 3,
          matchHints: [
            'full order',
            'full payload',
            'schema coupling',
            'schema version',
            'thin event',
            'bloat*',
          ],
        },
      ),
      exp(
        'retry-sweep',
        'The "log and retry in a background sweep" path has no durable record of the failed publish to retry from — what does the sweep read?',
        {
          impact: 4,
          trickiness: 4,
          detail:
            'Ties back to the outbox: without a persisted intent there is nothing for the sweep to replay.',
          matchHints: [
            'nothing to retry',
            'no record',
            'what does the sweep',
            'durable record',
            'persisted',
          ],
        },
      ),
    ],
    notes:
      'A dense distributed-systems review: the dual-write and partition-key/ordering flaws are the high-impact, high-trickiness wow catches.',
  },
]
