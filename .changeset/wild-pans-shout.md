---
---

Fix `deploy/local`'s `pnpm dev`, which spawned `@cat-factory/cli` by its bin name through a
`node_modules/.bin` shim pnpm cannot create on a fresh checkout, and add the guard that keeps any
package script from doing it again. No published package changes.
