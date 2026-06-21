import type { ImplementationFixture } from '@cat-factory/benchmark-harness'

// Smoketest coding tasks. Deliberately the kind of work a real coder agent does
// every day — not trivial (a one-line README), not a sprawling feature: add a
// small endpoint with a test, scaffold a tiny service. They reuse the benchmark
// harness's `ImplementationFixture` shape (repo + block + task) so the Pi-driven
// flow is identical; the smoketest just captures and analyses the transcript
// instead of grading the diff.
//
// The smoketest never runs the produced tests (there is no CI gate here) — it
// only clones the repo, runs Pi, and inspects what the agent did. So a fixture's
// repo only needs to make the task *sensible*, not to have a green toolchain on
// the developer's machine. All repos are small, public and long-stable; point a
// fixture at your own repo via the config's `fixtures` override when you want to
// smoketest against a specific codebase.

export type { ImplementationFixture }

export const SMOKETEST_FIXTURES: ImplementationFixture[] = [
  {
    id: 'healthcheck-endpoint',
    title: 'Add a /health endpoint + integration test',
    repo: {
      owner: 'heroku',
      name: 'node-js-getting-started',
      baseBranch: 'main',
      cloneUrl: 'https://github.com/heroku/node-js-getting-started.git',
    },
    block: {
      title: 'Service health check',
      type: 'service',
      description:
        'A small Express web app. Operators need a liveness endpoint to wire up to a load balancer and uptime monitor.',
    },
    task: [
      'Add a GET /health endpoint that responds 200 with JSON `{ "status": "ok" }`.',
      'Then add an integration test that starts the app (or its router) and asserts the',
      "endpoint returns 200 and the expected body — use the project's existing test",
      'setup if there is one, otherwise add a minimal one (e.g. supertest). Wire the test',
      'into the package.json "test" script so it runs with `npm test`.',
    ].join(' '),
  },
  {
    id: 'tested-helper',
    title: 'Add a small tested helper to a library',
    repo: {
      owner: 'sindresorhus',
      name: 'execa',
      baseBranch: 'main',
      cloneUrl: 'https://github.com/sindresorhus/execa.git',
    },
    block: {
      title: 'Input validation helper',
      type: 'service',
      description:
        'A widely-used process-execution library. Add a small, well-tested utility without disturbing the public API.',
    },
    task: [
      'Add a small internal helper function `isPlainArray(value)` that returns true only',
      'for a real Array (not array-likes), with JSDoc. Put it next to the existing',
      'helpers and add a focused unit test for it alongside the existing tests, following',
      "the repository's testing conventions. Do not change any public API.",
    ].join(' '),
  },
  {
    id: 'scaffold-service',
    title: 'Scaffold a tiny HTTP service from scratch',
    repo: {
      owner: 'octocat',
      name: 'Hello-World',
      baseBranch: 'master',
      cloneUrl: 'https://github.com/octocat/Hello-World.git',
    },
    block: {
      title: 'Minimal HTTP service',
      type: 'service',
      description:
        'An essentially empty repository. Bootstrap a minimal but real Node HTTP service into it.',
    },
    task: [
      'Create a minimal Node.js HTTP service (no external framework needed — the built-in',
      '`http` module is fine) exposing GET /health → 200 `{ "status": "ok" }`. Add a',
      'package.json with a "start" and a "test" script, and an integration test that boots',
      'the server on an ephemeral port and asserts /health returns 200 and the expected',
      'body. Keep it small and idiomatic; include a short README section on how to run it.',
    ].join(' '),
  },
]
