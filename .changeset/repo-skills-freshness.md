---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/agents': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

feat: repo-sourced Claude Skills — freshness automation (slice 4)

Keep a running pipeline from ever executing a stale skill, without the management
surface having to resync by hand (docs/initiatives/repo-skills.md, final slice):

- **Push-webhook fan-out.** A verified `push` webhook to a repo that skill sources are
  linked to now enqueues a targeted `skill-source-resync` job per affected source, so its
  skills are refreshed shortly after the upstream change. One indexed
  `SkillSourceRepository.listByRepo(owner, name)` lookup (new port method, D1 ⇄ Drizzle
  with a conformance assertion; the `skill_sources(repo_owner, repo_name)` index was
  already in place) drives the fan-out; the enqueue rides the existing GitHub-sync queue
  through a new `GitHubWebhookIngest.queueSkillResync` seam (Cloudflare Queue ⇄ Node
  pg-boss), and the async consumer runs `SkillSourceService.sync` for the one source
  (a source unlinked between enqueue and processing is swallowed, not retried forever).
- **Dispatch-time self-verifying probe.** At skill-step dispatch, `SkillRunResolver` now
  probes the source dir's head commit; if it advanced since the last sync it re-syncs so
  the run uses current instructions. It never fails the run — any probe/re-sync error
  degrades to the last-synced record (a run may be at most one push behind, never broken),
  and it's a no-op on the common unchanged path (one `latestCommitSha` read).

Together with the push fan-out this is the layered freshness story: the webhook keeps the
account catalog warm, and the dispatch probe is the correctness backstop for deployments
with no sync queue (local/dev) or a missed delivery. Backend-only; no harness/image change.
