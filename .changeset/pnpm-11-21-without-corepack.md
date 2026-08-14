---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': patch
---

Move the workspace to pnpm 11.21.0 and install pnpm from the registry rather than through corepack.

The UI-tester image staged pnpm and yarn with `corepack enable && corepack prepare …`, and that
line cannot work any more: the base is `node:26-trixie-slim`, and Node stopped shipping corepack,
so the `Dockerfile.ui` build failed before it reached the tooling it was staging and neither
manager was landing in the image at all. Both now install from the registry, pnpm at 11.21.0 and
yarn from `@yarnpkg/cli-dist@4.10.3` (yarn 4 is not published under the bare `yarn` name, which is
what corepack was covering for). A frontend that declares a different pnpm in `packageManager`
still gets that one, because pnpm honours the field itself.

Corepack is gone from the two deploy images as well, where it only ever put pnpm on PATH. They now
read the version out of the root `packageManager` field, so an image cannot install a pnpm that did
not write the lockfile it installs from. `@pnpm/exe`, the self-contained build, was tried first and
rejected: it links `libatomic.so.1`, which `node:24-slim` does not carry, and it would bundle a
second Node beside the one those images already run on.

The image tag moves to `cat-factory-executor:1.123.0` across the wrangler config, the publish
script and `RECOMMENDED_HARNESS_IMAGE`, since republishing over a live tag does not roll a
deployment out. The deploy image is unchanged and keeps `0.2.13`.
