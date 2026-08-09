import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The OS LEG: this Worker's object model driven by a REAL Cloudflare OS workspace.
//
// The hermetic suite fakes the cat-factory deployment and the live suite takes that fake away. Both
// of them fake the OTHER side: the workspace is a test object in the same isolate, so what neither
// can see is whether a real Workshop is happy with the shapes this Worker serves it. That is what
// this config boots, and it is the one leg allowed to go red on its own, because the thing it runs
// against is a partner repository that moves without us.
//
// It is a Node run rather than a workerd pool run, and the inversion is the point: Cloudflare OS's
// own `@gadgets/integration-tests` toolkit owns the runtime here, booting the real
// `workshop-backend` and this Worker together under wrangler's `createTestHarness()`. Their README
// asks a new gatekeeper's suite to be "point the harness at the package", which is exactly what
// `test/os-live/` does. Nothing about this Worker is re-composed for it: the harness reads
// `test/wrangler.jsonc`, the same file the other two suites boot from.
//
// The checkout is NOT vendored and NOT a dependency. `GATEKEEPER_OS_REF` pins a partner commit, the
// workflow clones it, and this config is handed the directory. A dependency would put their release
// cadence in front of this package's build, which the initiative's CI rule refuses; a default would
// let the suite boot against nothing and report the pass that "zero failures" always looks like.

/** The partner checkout, which the caller supplies. A missing one names who supplies it. */
function osCheckout(): string {
  const dir = process.env.GATEKEEPER_OS_DIR
  if (dir === undefined || dir.length === 0) {
    throw new Error(
      'GATEKEEPER_OS_DIR is not set. The OS leg runs against a checkout of ' +
        'cloudflare/cloudflare-os pinned by GATEKEEPER_OS_REF, which the `Gatekeeper OS leg` ' +
        'workflow prepares: run that, or clone the partner repo yourself and point ' +
        'GATEKEEPER_OS_DIR at it.',
    )
  }
  return resolve(dir)
}

const checkout = osCheckout()
const toolkit = resolve(checkout, 'packages/integration-tests/src')

/** Where this run's machine-readable result lands, for `scripts/grade-vitest-report.mjs`. */
const REPORT = resolve(import.meta.dirname, 'os-leg-report.json')

export default defineConfig({
  resolve: {
    // The toolkit is imported BY NAME, the way a repository vendoring the partner as a submodule
    // imports it, so the spec reads as the per-vendor suite their README describes rather than as a
    // path walk into somebody else's tree. Every other specifier those modules reach for (wrangler,
    // capnweb, zod) resolves from their own installation, which is the arrangement their own suite
    // runs in.
    alias: {
      '@gadgets/integration-tests/harness': resolve(toolkit, 'harness.ts'),
      '@gadgets/integration-tests/network-interceptor': resolve(toolkit, 'network-interceptor.ts'),
      '@gadgets/integration-tests/rpc-client': resolve(toolkit, 'rpc-client.ts'),
    },
  },
  server: {
    // The checkout sits outside this package, so Vite has to be told it may serve source from
    // there. Named explicitly rather than left to the workspace-root default, because where the
    // clone lands is the caller's choice.
    fs: { allow: [resolve(import.meta.dirname), checkout] },
  },
  test: {
    include: ['test/os-live/**/*.spec.ts'],
    // Two real Workers boot per file under wrangler, and a shared gadget is opened across several
    // RPC sessions inside one case.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One harness at a time: the workers bind fixed Durable Object namespaces, so files running
    // together would race on ports and persisted state.
    fileParallelism: false,
    // A suite that collected nothing exits 0, and this leg's whole value is that a red run means
    // something. Both halves of that are asserted rather than assumed: vitest refuses an empty run
    // here, and the report below is graded for specs that were merely SKIPPED, which an exit code
    // cannot see.
    passWithNoTests: false,
    allowOnly: false,
    // Declared here rather than passed on the command line so that every run writes one, local
    // included: the grader (`scripts/grade-vitest-report.mjs`) is then the same instrument whether
    // it is the nightly job or a person reading why a run went red.
    reporters: ['default', 'json'],
    outputFile: { json: REPORT },
  },
})
