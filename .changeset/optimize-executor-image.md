---
'@cat-factory/executor-harness': patch
---

Optimize the runner Docker image: install Pi extensions as the unprivileged
`harness` user (and `COPY --chown` the compiled wrapper) to drop the recursive
`chown -R` layer that duplicated the extension tree, collapse the two `pi install`
steps and the `git config` into single layers, and install the TS toolchain before
copying `src` so a source edit no longer reinvalidates the dependency layer. Behavior
is unchanged; the image is smaller and rebuilds faster.
