---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/gitlab': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Issue writeback is a `TaskSourceProvider` capability, and GitLab Issues accept webhooks

The engine's writeback (a comment when the PR opens, comment + resolve on merge, the intake
pickup claim, a parked review's questions and the acknowledgement of a reply) dispatched on a
hard-coded `github | jira | linear` chain inside one service. GitLab Issues, a shipped task
source, therefore had full intake and no way to answer it, and a tracker a deployment registers
could not have one however it was wired. Providers now declare `writeback`, the outbound mirror
of the existing `webhook` capability, and the service dispatches through the registry.

`GitLabIssuesProvider` also gains the inbound half: GitLab echoes a shared secret in
`x-gitlab-token` rather than signing the body, so its adapter compares that in constant time and
still fails closed on an empty secret. Board equality is now the source's own rule
(`TaskSourceProvider.sameBoard`), because GitLab project paths are case-sensitive where every
other board id folds.

A writeback adapter declares where it gets its authority (`authenticates`), which decides what an
unreadable tracker connection costs. Jira and Linear post with the stored bag, so a row that will
not open takes their writeback with it. GitHub Issues and GitLab Issues authenticate through the
workspace's VCS installation and read that row only for the inbound reply secret, so they keep
posting and lose just the reply grammar, which is withheld rather than promised.

Two internal breaks, per the pre-1.0 policy. The facades' `commentOnGitHubIssue` /
`closeGitHubIssue` / `labelGitHubIssue` writeback seams are gone (the source resolves its own
installation now), and a writeback for a workspace with no stored connection REFUSES where the
Jira and Linear legs used to return quietly: that silent return let the parked-review echo record
its idempotency marker for a comment the tracker never received.
