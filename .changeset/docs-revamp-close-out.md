---
---

Docs only: the documentation revamp closes with its last item and converts to ADR 0051
(`backend/docs/adr/0051-documentation-repo-website-split.md`), which supersedes the tracker
(`git rm`ed here, per the tracker lifecycle). No runtime behaviour changes; one operator message
changes where it points.

The close-out had two questions to answer before it could tick, and both were about the audit cell
that is cheapest to trust and hardest to notice: which docs here are still user-facing with no
website page. Re-derived from scratch against the site's live navigation rather than the cell, all
46 docs under `backend/docs/` and `docs/`. Exactly one survived,
`local-kubernetes-setup-windows.md`, and the reader test decided it: someone whose `cat-factory k3s`
run stops at "k3s runs only on Linux" has no checkout in that story. Installing the CLIs and
creating the cluster went to the website (cat-factory-website#30, merged ahead of this); what stays
here is the `K8S_IT_*` suite wiring and the version pins whose source of truth is CI's own job.

The CLI's Windows k3d message pointed at a repo path, which is the same reader with the same
missing checkout, so it now names the website page.
