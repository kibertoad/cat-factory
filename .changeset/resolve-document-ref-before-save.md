---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
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
by Figma, Zeplin and GitHub docs). That method is optional because the absence is a real fact rather
than a gap: Confluence needs the site base URL and Linear the workspace slug to build a link, so
those answer null and the id itself is the canonical form, which callers must render rather than
read as a failed resolution.

A refusal names WHICH correction it needs, as a closed `details.reason` vocabulary with two members
rather than one. `document_ref_unrecognized` means no link of this shape will work here and carries
the format that would; `document_ref_claimed_by_other_source` means the link is perfectly good and
aimed at the wrong source, and names the claimant so the picker can offer to switch with the text
unchanged. Collapsing them would tell someone who pasted a valid Figma frame URL into a Notion-backed
picker that their link is malformed. Claimants are searched host-PINNED first, reusing the ordering
`makeDocumentUrlResolver` already applies for the same reason: a blind parser claims a shape, so
registration order deciding would point a design link at Notion. The quoted input goes through
`redactSecrets`, since a pasted link routinely carries a `?token=` the error envelope would otherwise
echo into the logs.

The SPA half is the other side of one rule, not a second copy of it: the picker asks the backend
rather than restating any provider's parse, shows the trimmed canonical form on the row it is about
to stage (and says when it trimmed), and will not stage an unresolved reference at all. A resolve
call that FAILS leaves the reference unjudged rather than refused, and an unknown reason value falls
into the same bucket: reading a 502 or an older backend's vocabulary as "your link is wrong" is the
misattribution this surface exists to avoid. Fetching moved ahead of the create too
(`useContextLinking().resolvePending`, used by both the add-task and create-initiative forms): every
attachment is imported before the block is written, all failures are reported together rather than
one round trip at a time, and nothing is created while any of them is unresolved, so the correction
is made with the form still open. What stays after the create is the LINK step alone, whose realistic
failure is a document another task already holds.

Reviewing: the interesting part is the split between "the source refused this" and "we could not
ask", since only the first may be shown to a user as a bad link. Worth checking too that the picker
stages the RESOLVED external id rather than the pasted text (there is a round-trip test for it: a
provider whose bare-id branch were stricter than its URL branch would refuse the very reference the
pre-flight approved), and that a task is genuinely not created when an attachment cannot be fetched.
Nothing about the description-paste path changed: a URL named in prose still resolves best-effort
against the imported corpus and still degrades to an info log when it matches nothing.
