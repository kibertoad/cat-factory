---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Close three of the gaps `backend/docs/security-model.md` lists against the agent write path.

**`allowInitiatorPat` turns "govern your members' PATs" from advice into an enforced control, at
two tiers.** A run's initiator's stored personal token outranks the deployment credential, and its
scope is whatever that person granted it — so the blast radius of a compromised run was a property
of whoever pressed start. Off, every run authenticates as the App installation and the initiator's
token is never decrypted. All three mint sites (both facades' container dispatch and the engine's
GitHub client) now route through one `createResolveRunInitiatorToken` decision, and an unreadable
settings row fails closed to the App token.

The per-workspace switch is edited with `settings.manage`, which a member elevated on one board
holds — so it alone could not bind the case it exists for. An **account-wide floor** sits under it:
effective = account permits AND workspace permits, with the account tier out of a board admin's
reach. It ships UNSET, and that default is load-bearing rather than merely cautious — a personal
token is the right credential for someone adopting cat-factory alone inside an org that has not,
where there is no App installation to inherit and no account admin to ask. PAT support is
unchanged for them.

**A stored GitHub PAT's breadth is stated when it is tested or saved.** A classic token carrying
`repo` is called out as reaching every repository its owner can push to; unused scopes are flagged;
a token whose scopes GitHub does not report is reported as unknown rather than passing as narrow.

**A branch-protection preflight says where the operator checklist's first item is missing.** On
demand, the GitHub settings panel probes each linked repository's default branch and reports three
states — a repo it could not reach is `unknown`, not "fine" — plus whether a protected branch's rule
was actually readable, and how many repositories a probe cap left unchecked. It answers to
`integrations.manage` and probes with bounded concurrency: unlike its sibling reads it spends the
installation's GitHub rate limit, which the CI gate and the merger draw on for every run.

It reads **rulesets as well as classic branch protection**. Rulesets are how protection is enforced
org-wide and leave no classic rule behind, so a legacy-only probe reported the best-configured
repositories as exposed — a false alarm on a panel whose only job is naming exposed ones. The rules
endpoint also needs no admin, so a minimally-scoped App installation now gets real detail where it
previously got `detailUnavailable`.

The operator checklist now names **GitHub's own org-level PAT controls first**, since they bind
every tool a member uses and cannot be undone by them — with the caveat that they are the wrong
instrument for individual adoption, which is what ours are for. The residual-gaps list records
GitHub App **user-to-server tokens** as the structural fix for an unbounded initiator token
(`auth/GitHubOAuth.ts` already implements that flow for login), so the next iteration does not
re-derive "a PAT cannot be narrowed" as permanent.

BREAKING for anything constructing these directly: `RunInitiatorScope` now takes a
`{ workspaceId, initiatedBy }` scope rather than a bare user id, `MintInstallationToken`'s run
context carries `workspaceId`, and `PatPreferringAppRegistry` takes the composed token decision
instead of a raw `ResolveUserGitHubToken`. `currentInitiator()` is removed in favour of
`currentCredentialScope()`.
