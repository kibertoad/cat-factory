# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
Every change that affects a published or versioned package needs a changeset.

Add one with:

```sh
pnpm changeset
```

Pick the packages and bump levels, write a one-line summary, and commit the
generated `.changeset/*.md` file with your PR. On merge to `main`, the release
workflow opens/updates a "Release Packages" PR; merging that PR versions the
packages, updates changelogs, and publishes the public ones to npm.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full authoring guide,
including the rule that **image-affecting** changes must bump
`@cat-factory/implementer-harness` so the runner Docker image is republished.
