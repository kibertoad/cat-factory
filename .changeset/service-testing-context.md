---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Let a service say, in its own words, how it should be tested

A Tester was handed two things about a service it did not stand up: where to reach it, and which
credentials its shell carries. Neither says which flows matter, which of the seeded accounts is the
one to sign in as, what the demo data means, or which flow charges a real card. That knowledge
exists, it is short, and until now there was nowhere to put it, so every Tester run rediscovered it
from the repository or guessed.

**Testing context** is a freeform text box on the service frame's inspector, directly beneath the
sealed test credentials (advanced interface tier, and shown at either tier once a service records
one, so nobody is left unable to read or clear what their testers are being told). It is stored on
the service and injected verbatim into every tester prompt for it. The environment self-test's agent dry run is handed the same text through the same renderer:
a dry run's whole claim is that it predicts what a real Tester will be able to do here, and it cannot
predict that from a different briefing.

Three decisions worth knowing:

- **It is non-sensitive by contract**, because it is rendered INTO the prompt. Secrets stay in the
  sealed panel above, which never renders a value into a prompt or into telemetry, and this prose
  refers to them by variable name. The panel says so.
- **The empty case is stated to the agent, never omitted.** A Tester told nothing cannot tell "this
  platform has nowhere to write that down" from "the place exists and nobody filled it in", so it
  either reports no gap at all or reports one against the service. Told, it reports what it had to
  guess at, which is what tells an operator what to type. A tester running on work that sits under
  no service frame is told THAT instead, so an empty field and an absent owner cannot be reported
  as the same neglect.
- **It is a `blocks` column, not a table**, for the reason `provisioning` and `service_connections`
  are columns: one service-frame-owned value the engine reads off the frame it has already walked
  to. Both runtimes gain the column and a conformance assertion drives the frame-chain walk on both
  stores; the write boundary drops the field on any non-frame block rather than persisting dead data.

Only the two tester kinds are handed it, so every other agent's prompt is byte-for-byte unchanged,
and a service that records nothing keeps the prompts it had.
