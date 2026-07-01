---
'@cat-factory/agents': patch
---

fix(tester): give the Tester standardized env coordinates + real access credentials in its prompt

The tester prompt claimed a deployed environment's URL and access credentials were "provided to
the test harness out of band" — but nothing delivered them, so Testers aborted with "no deployed
URL or credentials found". `environmentSection()` now renders the standardized coordinates
(URL + derived host/port/scheme) and the FULL endpoint access credentials (bearer token / HTTP
basic username+password / custom header name+value) directly in the run context.

These are test-environment access credentials, treated as non-sensitive: the Tester cannot
authenticate without them reaching the model regardless of channel, so they go straight into the
prompt rather than a fictional out-of-band path. The tester system prompts and run-mode wording
now point at the concrete "Ephemeral environment under test" section.
