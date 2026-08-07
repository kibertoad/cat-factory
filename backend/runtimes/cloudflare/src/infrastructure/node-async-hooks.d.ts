// The one `node:` surface the Worker uses: `AsyncLocalStorage`, which workerd provides under
// the `nodejs_compat` flag both wrangler files set (see `requestContext.ts` for what rides it).
//
// Declared here rather than by depending on `@types/node`, because `types` in this package's
// tsconfigs is the Workers global environment and adding `"node"` to it would let every
// Node-only global (`process`, `Buffer`, `fs`, a Node-shaped `setTimeout`) typecheck across a
// runtime that cannot run them. That is a repo-wide loosening bought for a single import; a
// narrow declaration keeps the Workers environment honest.
//
// The shape is the stable subset (`run` + `getStore`), which is also what the TC39
// AsyncContext proposal standardises. If a future `@cloudflare/workers-types` declares
// `node:async_hooks` itself, delete this file and take theirs.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R
    getStore(): T | undefined
  }
}
