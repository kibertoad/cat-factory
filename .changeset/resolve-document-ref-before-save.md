---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

A pasted document link is judged before the task is saved, not after

Attaching a page to a task accepted whatever text sat in the picker's box. The only thing that ever
checked it was the IMPORT, and the import ran after the task had been created, so a link the source
could not read produced a task that already existed, carrying context it never got, with the verdict
arriving as a toast over a closed dialog. A Figma share link is where this bit hardest, because the
Copy link button emits a title segment plus `?p=` / `&t=` tracking params on top of the frame's node
id: that whole string was staged verbatim, and a node id the parser cannot read degrades silently to
the WHOLE FILE, so "I attached this frame" and "I attached the entire design" looked identical right
up until an agent read the wrong thing.

`POST /document-sources/:source/resolve-ref` is the fix's spine: `DocumentImportService.resolveRef`
is `import` with the fetch removed, and `import` now goes through it rather than parsing again, so
the pre-flight and the import cannot disagree about which refs are usable. It spends no upstream
call and needs no connection, which is what makes it cheap enough for the picker to call as the user
types. It answers the canonical form the reference will be stored under, including a `canonicalUrl`
the provider rebuilds from the id (a new optional `DocumentSourceProvider.canonicalUrl`, implemented
by Figma, Zeplin and Notion). That method is optional because the absence is a real fact rather than
a gap, and the two shapes of absence are worth keeping apart: Confluence needs the connection's site
base URL and Linear the workspace slug, while GitHub docs has everything but the HOST, which is a
deployment fact (a GitLab-backed deployment reaches that source through the VCS adapter, so a
`github.com` link built from the id would be wrong for it and presented as the supported form the
paste was trimmed to). All of them answer null, and the id itself is the canonical form there, which
callers must render rather than read as a failed resolution.

A reference the provider could only parse by DROPPING the frame it named says so on its own field.
`parseRef` falling back to the whole file is right (nothing knows which frame a complex instance id
meant, and Figma's Copy link emits one for any component instance), but the fallback is invisible: a
valid id, a valid canonical URL, and a "trimmed to the supported form" note that reads the same
whether tracking params were dropped or the whole design was swapped in for one frame. The new
optional `DocumentSourceProvider.droppedScope` carries the discarded qualifier as pasted, and the
picker gives it its own warning line, because a trim and a widening are opposite facts.

A refusal names WHICH correction it needs, as a closed `details.reason` vocabulary with two members
rather than one. `document_ref_unrecognized` means no link of this shape will work here and carries
the format that would; `document_ref_claimed_by_other_source` means the link is perfectly good and
aimed at the wrong source, and names the claimant so the picker can offer to switch with the text
unchanged. Collapsing them would tell someone who pasted a valid Figma frame URL into a Notion-backed
picker that their link is malformed. Claimants are searched host-PINNED first, through the same
`orderSourcesByClaimConfidence` the prose-URL canonicaliser reads rather than a second copy of its
two passes: a blind parser claims a shape, so registration order deciding would point a design link
at Notion, and a confidence rule living in two places gets refined in one of them. The quoted input
goes through `redactSecrets`, since a pasted link routinely carries a `?token=` the error envelope
would otherwise echo into the logs. Both reason codes reach `/api/v1` through the public task-create
attachment, so the surface version steps to `1.19.0` and `public-api.md` names them.

The SPA half is the other side of one rule, not a second copy of it: the picker asks the backend
rather than restating any provider's parse, and shows the canonical form on the row it is about to
stage, saying when it trimmed and, separately, when the reference is WIDER than what was pasted. Only
the source's own refusal blocks a paste: a resolve call that FAILED leaves the reference unjudged and
still stageable with the import as the backstop, and an unknown reason value falls into that same
bucket, because reading a 502 or an older backend's vocabulary as "your link is wrong" is the
misattribution this surface exists to avoid, and an outage that made attaching impossible would be a
worse failure than the one being fixed. Fetching moved ahead of the create too
(`useContextLinking().resolvePending`, used by both the add-task and create-initiative forms): every
attachment is imported before the block is written, all failures are reported together rather than
one round trip at a time, and nothing is created while any of them is unresolved, so the correction
is made with the form still open. That raises the bar on saying WHICH attachment is at fault, so a
failed fetch is marked on the staged chip itself and not only in the toast, and the add-task form's
issue-body pre-fetch records its cause instead of swallowing it (a tracker reference has no
`parseRef` to pre-flight, so that attempt is its pre-flight). What stays after the create is the LINK
step alone, whose realistic failure is a document another task already holds.

Reviewing: the interesting part is the split between "the source refused this" and "we could not
ask", since only the first may be shown to a user as a bad link, and the parallel split between a
trim and a widening. Worth checking too that the picker stages the RESOLVED external id rather than
the pasted text (there is a round-trip test for it: a provider whose bare-id branch were stricter
than its URL branch would refuse the very reference the pre-flight approved), and that a task is
genuinely not created when an attachment cannot be fetched. Nothing about the description-paste path
changed: a URL named in prose still resolves best-effort against the imported corpus and still
degrades to an info log when it matches nothing.
