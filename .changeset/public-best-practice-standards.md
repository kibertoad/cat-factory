---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Pick the best-practice standards a task is judged against, over `/api/v1`

A workspace curates best-practice standards, merged across the deployment's shipped catalog, the
account's library and the board's own; an agent working under one is held to it, and a reviewer
additionally rates how closely the change followed each. Which of them apply is a real per-task
question (a security sweep, a migration, a pull request in a repository whose rules differ from its
service's), and it was answerable from the app and from the internal API and nowhere else. A caller
filing a review headlessly could name the pull request, the focus, the pipeline and the model, and
could not say what the reviewer was to judge it against. Its only lever was the enclosing SERVICE's
standing set, which is the right default and aims any change at every other task under that service.

`GET /api/v1/prompt-fragments` serves the merged catalog and `fragmentIds` on task creation names
ids from it, the same pairing `GET /api/v1/task-types` has with `fields`. `PublicTask` reads back
`fragmentIds`, which is the one pin a caller cannot predict from what it sent: the platform unions
the list with the service's standards and the task type's defaults and freezes the result.

**The catalog carries each standard's identity, not its `body`.** Naming a standard needs the id,
the title, the category, the one-line summary and the tags, which is also exactly what the
platform's own relevance selector decides from; the body is the authored text of an organisation's
engineering guidelines, which is a different thing to publish than a list of what it has written
down. Each entry also says which `tier` it won on, because an account-wide rule and one this board
authored need different fixes when a standard is wrong.

**The read sits at `write`, not at `read`.** Withholding the body is not enough to make the lower
floor honest: a standard imported from a repo of Markdown guidelines carries no authored summary,
so the importer derives one from the opening of the file, and for those entries the published
`summary` is a capped slice of the guidance itself. `write` is the scope that NAMES a standard on a
task, which keeps the discovery pairing exact (a key that can fill `fragmentIds` can read the
vocabulary it fills it from) with nothing derived from an org's guidelines below it. It stays under
the `admin` the preset libraries take, because naming a standard is not managing one.

**The list is keyset-paginated from this first release** (`?limit=`, `?cursor=`, `nextCursor`),
ordered by `fragmentId`. A catalog is not self-limiting: a tier can link a repo directory and get
one standard per Markdown file, so an unbounded first release would have left only a `/v2` or a
silent truncation as the way to add the bound afterwards.

**Fragment ids have ONE ceiling now** (`MAX_FRAGMENT_ID_LENGTH`), shared by the hand-authored `id`,
the repo-source mint and this public field, which is what makes "the catalog serves it ⇒ the create
accepts it" structural rather than a coincidence of two numbers. A sourced id is
`src:<sourceId>:<slugified path>` and had no bound at all, so a deep enough guidelines directory
produced ids the create door would have refused with a generic length error. The mint now truncates
with a stable digest of the slug (a prefix cut alone drops the filename, which is the half that
distinguishes siblings in a deep tree), and a file whose FRONTMATTER declares an over-long id is
declined with a warning rather than shortened, since that id is the author's own choice and a
rewritten one shadows nothing. Existing sourced fragments with an over-long id are re-minted on the
next sync: the old id tombstones and the new one starts at version `1.0.0`.

**An id the board does not resolve is refused** (`422`, `details.reason:
'prompt_fragment_not_found'`, `details.fragmentIds` naming every one that missed) where the RUN path
drops it. The run path is right to drop: a standard deleted after a task was filed must not break
the run. At the door it is the wrong disposition, because a typo would answer `201` for a review
that folded nothing, which reads afterwards exactly like a review nobody asked to be judged against
anything. The check lives at this door rather than on `BoardService` beside the preset-pin guard,
and the reason is not the store it reads: the app's create form submits the service's inherited
standards verbatim alongside the person's own picks, so the same refusal there would turn one stale
library id into a service nobody can file a task under. Here every id was named by the caller, in
the same request cycle it read the catalog in. The route now checks the CONTAINER before any of
this: every other refusal on it presumes a service that exists, so answering an unknown-standard
`422` for a typo'd `serviceId` sent an integrator to fix the wrong end of a two-part mistake.

The `blockTypes` value set is now pinned in the SDK IR's enum table. It is shared with
`publicService.type` and is walked first alphabetically under its new home, so leaving it positional
would have respelled the published `PublicServiceType` in four clients as a side effect of adding an
unrelated endpoint, arriving as a clean generated diff nobody reads.

OpenAPI `info.version` 1.72.0 -> 1.73.0. The Python and Java clients (Kotlin with them) carry the
new operation and models, so their manifests move 0.7.0 -> 0.8.0: for those two the version change
IS the release, so regenerating without it would have shipped the catalog in two clients of four.
