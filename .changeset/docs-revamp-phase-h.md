---
---

Docs only: the documentation revamp closes items 21 and 22
(`docs/initiatives/documentation-revamp.md`), the last two reductions, and with them the last two
rows that read "unread" or "blocked". No runtime behaviour changes.

Both docs were BLOCKED on a website page rather than unassessed, and both were cleared by writing
the page first (cat-factory-website#29, merged ahead of this). `kubernetes-topology.md` goes 219 →
65: the site now owns what runs where, the control-plane / data-plane split, the RBAC verbs, the
egress set, reaping and sizing, and the doc keeps the four things a change to the `kubernetes`
runner backend has to hold (the idempotent `409 AlreadyExists` re-attach, why a bare Pod rather than
a Job and what that costs, the pod-proxy being the only route into a Service-less pod, and the
scheduler's `jobId`-sticky routing). `document-sources.md` goes 588 → 551: what a pasted reference
resolves to and who may connect a source versus attach one were user-visible behaviour written as
implementation, and both moved.

**Reducing turned up the same rot on this side that item 20 found on the website's.** The
`document-sources.md` intro named the two providers that shipped when it was written; there are six.
No guard could see it and nothing linked it, and the fix is not a longer list: the doc now points at
the site for what ships and at `documentSourceKindSchema` for the vocabulary the code reads, because
an inventory rots wherever it is restated.
