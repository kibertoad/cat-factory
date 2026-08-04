---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Run evidence and key provisioning on `/api/v1`, and a trajectory link on the PR report

Everything the platform captured about a run was reachable only from a browser session. A consumer
whose job is to JUDGE a run — a trial harness deciding whether to accept a change, an evaluation
pipeline scoring a fleet — could scrape the fenced JSON block out of a pull-request body and read
`/api/v1/debug/*`, and that was all: the captured screenshots were unreachable, and a run with no
pull request (a headless job, a run that failed before it pushed) had no evidence surface at all.
Getting a key at all still needed a browser.

Three additions, all `/api/v1`:

- **`GET /runs/:runId/report`** serves the engine's verification report — the SAME bundle it writes
  onto the pull request, composed on read by the same code, so the two can never disagree about
  what a run proved. It answers for runs that never opened a pull request, and it does not consult
  the `publishPrVerificationReport` opt-out, which is a statement about writing onto someone else's
  pull request rather than about reading your own evidence back.
- **`GET /runs/:runId/artifacts`** and **`GET /artifacts/:artifactId/blob`** list a run's captured
  artifacts and stream their bytes, at `read` scope, with the content type clamped to the image
  allow-list exactly as the session-authed route does. An account with no blob backend gets a 503,
  never an empty list.
- **`GET|POST|DELETE /keys`** provisions keys headlessly at `admin` scope. Two enforced bounds make
  that safe: a key minted here can never reach the `admin` rung minting requires (so the chain is
  one link long), and revoking a key now revokes every key it minted, on this surface and in the
  app alike — otherwise a leaked provisioning key would survive its own revocation.

The **PR verification report** gained the links a machine needs: `observability.trajectoryUrl` (the
run's tool calls in the order the agents made them) and `observability.reportUrl` (this report,
served live), both rendered in the prose as well as carried in the JSON, and both built from the
deployment's public BACKEND url. Report payload version 5 → 6.

Worth knowing when upgrading:

- **The report shape is now part of the STABLE public surface.** It is served verbatim on
  `/api/v1`, so from here it grows additively and never renames or retypes in place.
- **A new `created_by_key_id` column** on `public_api_keys` (D1 migration `0081`, its Drizzle
  mirror, plus an index), which carries the provenance of a headless mint and is what the
  revocation cascade follows. The app's key panel renders it, so a provisioned key no longer reads
  as one whose minter is unknown.
- **The SDK chain learned binary responses.** An operation whose success body was neither JSON nor
  SSE previously generated as a method that returned NOTHING; the IR now marks it `binary`, each
  of the four transports hands the bytes back in its own idiom, and an unrecognised media type
  fails generation instead of silently discarding a body.
- **A container wiring bug is fixed on both facades**: the HTTP layer's binary-artifact store
  resolver was built from account settings while the engine's came from `CoreDependencies`, so an
  override reached one side of the app and not the other.
