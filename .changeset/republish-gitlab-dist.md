---
'@cat-factory/gitlab': patch
---

Republish with the compiled `dist/` payload. A prior `pnpm publish` ran without a build
step, so the tarball shipped as an empty shell (only `package.json`, no `dist/`) and the
package could not be imported. A `prepublishOnly` build hook now guarantees the package is
compiled before it is packed, regardless of how publish is invoked.
