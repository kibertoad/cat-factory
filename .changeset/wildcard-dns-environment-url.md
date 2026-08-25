---
'@cat-factory/contracts': patch
'@cat-factory/integrations': patch
'@cat-factory/acceptance': patch
'@cat-factory/cli': patch
---

Refuse an ephemeral-environment URL that resolves to the wrong network.

`nip.io` and `sslip.io` answer from the leftmost four-octet run in a hostname and read `-` and `.`
as the same separator, so a per-PR namespace ending in a separator plus digits contributes an
address of its own and wins: `cf-env-catalog-api-5.127.0.0.1.nip.io` resolves to `5.127.0.0`. The
platform's default namespace had exactly that shape for every pull request, and the URL was
published unverified, so the environment rolled out, reported `ready`, and the failure first
surfaced at the `tester` step as a connection error naming the cluster rather than the config.

Every environment URL is now graded where every provider's URL is published (the sync provision,
the async deploy-container finalize, and the status reconcile all settle on one seam beside
`assertSafeEnvironmentUrl`), so a URL rendered inside a deploy harness or read off a live Ingress
is checked exactly as one derived in process is. The Kubernetes provider additionally grades its
RENDERED ingress host before it creates anything, and refuses as `config_incomplete`: the late
check it replaces ran past the namespace, the registry pull Secret and every applied workload, and
a failed provision records no `externalId`, so each refusal leaked a namespace nothing could
reclaim. Grading the rendered host also sees what a parsed URL cannot, since an authority stops at
the first `/`. The rule is `describeWildcardDnsShift` in `@cat-factory/contracts`, and every remedy
it offers is re-graded against the rule before being printed (telling someone already using dashes
to "write the address with dashes" was a description of their broken config, not a fix).

**Behaviour change to defaults, deliberately breaking.** The default per-PR Kubernetes namespace is
now `cf-env-<repoName>-pr<pullNumber>`, the guided `cat-factory k3s` setup writes
`cf-env-pr{{pullNumber}}` with a `{{namespace}}.127.0.0.1.nip.io` host (a `{{branch}}` host renders
`cat-factory/<taskId>`, whose `/` ends the hostname), and the acceptance suite defaults to
`cf-acc-pr{{pullNumber}}`. New provisions land in differently-named namespaces than before;
existing environments keep the namespace persisted on their record, so teardown still reclaims
them. Without this, an operator who left the defaults alone would move from silently wrong to
hard-failing at the deployer step with no automated fix.

The acceptance `ingress-template` preflight now grades the namespace and host templates COMPOSED,
once per repository the pass provisions, which is the only way this class of fault is visible.

Corrects the belief that made the failure invisible on both sides, wherever it was still written
down: `nip.io` does not map `<anything>.127.0.0.1.nip.io` to loopback.
