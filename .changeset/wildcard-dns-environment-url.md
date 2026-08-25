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
platform's default namespace has exactly that shape for every pull request, and the URL was
published unverified, so the environment rolled out, reported `ready`, and the failure first
surfaced at the `tester` step as a connection error naming the cluster rather than the config.

The Kubernetes environment provider now refuses such a provision as `config_incomplete`, naming
both addresses and stating that the manifests are not at fault. The rule is `describeWildcardDnsShift`
in `@cat-factory/contracts`, graded on the rendered host, so a correctly-composed name is untouched.

The acceptance suite's default namespace template becomes `cf-acc-pr{{pullNumber}}`, and its
`ingress-template` preflight now grades the namespace and host templates COMPOSED rather than each
alone, which is the only way this class of fault is visible.

The guided `cat-factory k3s` setup keeps probing loopback directly, which is the right split, but
the comment claiming `nip.io` maps `<anything>.127.0.0.1.nip.io` to loopback is corrected: that
belief is what made this failure invisible on both sides.
