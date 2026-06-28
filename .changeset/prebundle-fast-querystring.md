---
'@cat-factory/app': patch
---

Pre-bundle `fast-querystring` so the SPA doesn't throw at runtime.

The app layer's HTTP client (`@toad-contracts/frontend-http-client`) imports the named
`stringify` export from `fast-querystring`, a CommonJS module. In Vite dev it was served raw
from `@fs`, where `cjs-module-lexer` can't detect the named export — `fast-querystring`
reassigns its exports (`module.exports = x; module.exports.stringify = …`) — so any
deployment extending this layer threw at runtime:

`SyntaxError: … fast-querystring/lib/index.js does not provide an export named 'stringify'`.

Force Vite to pre-bundle it via `optimizeDeps.include` so esbuild emits an ESM wrapper with
proper CJS interop (`needsInterop`). The specifier is resolved from the consumer app's root,
where under pnpm's strict layout only `@cat-factory/app` is hoisted, so it is anchored there
using Vite's nested `a > b > c` syntax.
