---
---

Docs, tests and two error-remedy doc URLs: the documentation revamp closes slice 15 and item 12b
(`docs/initiatives/documentation-revamp.md`). No runtime behaviour changes.

**Two live catfactory.ai pages had stopped describing the code, and reducing against them is what
found it.** `extend/custom-gates.md` told a deployment author to import `wireProvider` and
`isProviderWired` from `@cat-factory/kernel`; neither is exported, because provider wiring moved to
an app-owned `ProviderRegistry` instance the facade injects. `extend/custom-providers.md` told them
to pass `environmentProvider` to `buildNodeContainer` / `startLocal`, an option removed when
environment backends became a registry keyed by `kind`. Both pages resolved, carried more sections
than the repo docs pointing at them, and would not compile. That is a third check on top of the two
this initiative already had: existence (item 14) and depth (item 17). Nothing automatic can make it,
since a code fence is not a link and neither repository's CI can typecheck the other's prose.
cat-factory-website#28 is the fix and merged first.

The nine remaining slice-15 docs are reduced (-397 lines), the largest being `github-operations.md`
at 188 → 71, where the website already owned the setup path in more depth than the runbook did. Two
config remedies whose instruction moved with it (`GITHUB_APP_PRIVATE_KEY`'s PKCS#8 conversion and
the node facade's "no GitHub token source" boot warning) now point at the website through a new
`SITE_DOCS.githubApp` entry, and the two specs that asserted every remedy links an in-repo blob URL
were widened to allow a site URL while pinning it to the `SITE_DOCS` registry, which is what keeps
it inside the website repo's weekly crossing guard.

`kubernetes-topology.md` is the one doc read and deliberately NOT cut: `deploy/kubernetes.html`
stops at the connect form, so an operator can fill it in and still cannot lay out the cluster. The
tracker records what that page owes rather than cutting ahead of it.
