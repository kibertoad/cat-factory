// Minimal, runtime-neutral ambient declaration of the ONE Node built-in this package relies
// on: `AsyncLocalStorage` from `node:async_hooks` (see `github/runInitiatorContext.ts`).
//
// `@cat-factory/server` is the runtime-neutral HTTP layer shared by every facade — its
// tsconfig deliberately runs with `"types": []` and only the Web-standard `lib` globals, so a
// stray Node-only import in `src` (`node:fs`, `process`, disk `Buffer`, …) STILL fails to
// typecheck and can't silently break on workerd. `AsyncLocalStorage` is the sanctioned
// exception: it is supported on BOTH Node and the Cloudflare Workers runtime (both facades
// enable `nodejs_compat`), so we type just it here rather than pulling in the whole `@types/node`
// surface. The test project (`tsconfig.test.json`) opts into `@types/node` instead and excludes
// this file, so the two declarations never collide.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined
    run<R>(store: T, callback: () => R): R
    enterWith(store: T): void
    disable(): void
  }
}
