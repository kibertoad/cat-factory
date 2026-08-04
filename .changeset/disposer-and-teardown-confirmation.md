---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
---

Disposer step, and a teardown that is proved rather than assumed

A run's PR asserts a three-leg proof — the test environment came up, evidence was captured against
it, and it was torn down again — and the third leg had two problems.

Nothing closed it inside the run. Teardown happened only on the TTL sweep, a manual Destroy, a
`human-test` resolution, or a re-provision supersede. The sweep fires long after the last step
settled, so the report was published saying the environment was still live and corrected later
through a back-channel, and only where a provisioning log is retained. TTL is a backstop; it
cannot be a proof.

Worse, the teardowns that did happen were never checked. Success was recorded whenever
`provider.teardown()` returned without throwing, which is a different fact from the environment
being gone: `HttpEnvironmentProvider` reports `torn_down` unconditionally, so a manifest with no
`teardown:` request destroys nothing and still reports success, and a Kubernetes namespace
`DELETE` returns while the namespace is still `Terminating`. The section could therefore render a
green tick about an environment that was still running and still billing.

So teardown now has two halves. A new optional `EnvironmentProvider.confirmTeardown` re-probes
after the destroy call and the result is recorded as its own `teardown-verify` log row; only a
probe that positively finds the environment gone counts as a reclaim. This is deliberately not
folded into `status()`, whose implementations are all written to describe a LIVE environment — the
generic provider with no `status:` template answers `ready` forever, and the compose mapping reads
an empty project as `failed`, both of which are exactly inverted as teardown verdicts. The four
outcomes stay distinct because each needs a different person: confirmed, still standing (the
teardown was a no-op — fix the config and reclaim by hand), unverifiable (the provider has no way
to tell you, and no retry will change that), and unconfirmed (transient; the next sweep re-probes).

And a new `disposer` step, the deployer's counterpart, reclaims what the run provisioned wherever
its author places it — after the automated tester, or after a human has finished with the live
URL. It reads the frames off the deployer's own recorded outcomes rather than re-deriving them, and
it never fails the run: it commonly sits after `merger`, so an un-reclaimed environment is a
recorded warning and an operator's job, not a failed pipeline. It is palette-addable rather than
seeded into the built-in pipelines; seeding it is a follow-up that needs its own version bumps.

The provisioning-log operation vocabulary is part of `/api/v1`, so `teardown-verify` is an
ADDITIVE public-API change: the OpenAPI surface goes to 1.9.0 and the four SDK clients plus the
MCP facade are regenerated from it. The SDKs tolerate unknown enum values by design, so an older
client decodes the new row as a plain string rather than failing.

Two things to watch when reviewing. The report gains a `teardown: 'unconfirmed'` state, and
because a missing verify row is treated as "not proved" rather than as a pass, runs whose
teardowns predate this change will report unconfirmed rather than confirmed. That is a correction,
but a visible one. And the confirmation applies to every teardown path, not just the new step, so
a deployment whose provider config makes teardown a silent no-op will start being told so.
