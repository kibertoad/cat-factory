import type { PromptFragment } from '@cat-factory/contracts'

// Best-practice fragments for Node.js / backend work. Each fragment's `body` is
// injected verbatim into the agent system prompt when selected, so keep it
// concise, imperative and standalone.

export const nodeFragments: PromptFragment[] = [
  {
    id: 'node.performance',
    version: '1.0.0',
    title: 'Node.js performance',
    category: 'Node',
    summary: 'Avoid event-loop blocking, stream large payloads, cache hot paths.',
    body: [
      'Node.js performance standards:',
      '- Never block the event loop: move CPU-bound work to worker threads or break it into async chunks.',
      '- Prefer streaming (Readable/Writable streams) over buffering large payloads in memory.',
      '- Reuse connections and clients (HTTP agents, DB pools); do not create them per request.',
      '- Cache expensive, idempotent computations and hot lookups; set explicit TTLs.',
      '- Measure before optimising: profile with --prof / clinic and quote concrete numbers, not guesses.',
    ].join('\n'),
    appliesTo: { blockTypes: ['service', 'api', 'queue', 'integration'] },
  },
  {
    id: 'node.best-practices',
    version: '1.0.0',
    title: 'Node.js best practices',
    category: 'Node',
    summary: 'Async/await error handling, config via env, structured logging, graceful shutdown.',
    body: [
      'Node.js best practices:',
      '- Use async/await with explicit try/catch; never leave promises unhandled.',
      '- Read configuration from the environment; never hard-code secrets or hosts.',
      '- Validate all external input at the boundary before it reaches domain logic.',
      '- Emit structured (JSON) logs with correlation ids; do not log secrets.',
      '- Handle SIGTERM/SIGINT for graceful shutdown: stop accepting work, drain, then exit.',
    ].join('\n'),
    appliesTo: { blockTypes: ['service', 'api', 'queue', 'integration', 'external'] },
  },
]
