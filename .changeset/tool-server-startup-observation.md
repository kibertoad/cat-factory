---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Record what the agent's CLI said about the tool servers it loaded, beside what the dispatch decided

A step's tool-server record has answered one question since it landed: what the platform wired for
the agent, and what it withheld and why. It cannot answer the other one. A server that passes every
check, resolves its credential, survives the budget and reaches the container can still fail to come
up there: a vendor endpoint that 500s, a pinned `npx` package that no longer resolves, a token the
vendor revoked between dispatch and launch. In every one of those the prompt promises the agent a
tool that never exists, and the only evidence was the agent mentioning it in prose, if it noticed.

The claude-code CLI announces its resolved session before its first model call, naming the MCP
servers it loaded with a status each, plus the flat list of tools it will expose. The harness reads
that one event and publishes it on the job view; the engine folds it onto the same
`step.toolServers` record the dispatch wrote, and the step detail renders it on the existing chips.
Both halves are kept, never merged into one status: the platform withholding a tool and the CLI
failing to start one are different faults for different people.

The distinctions this is built out of are the whole point, because each one reads as a healthy
server if it collapses:

- **Not observed is not "nothing was loaded."** Codex's CLI publishes no such report, nor does any
  image older than this one, nor a runner pool whose manifest does not map the field. All of them
  leave the record's observed half ABSENT, and the surface then says nothing at all rather than
  accusing every wired server on every deployment one release behind.
- **Started-with-no-tools is not started.** A server that connects and exposes nothing reaches the
  agent exactly like one that was never wired, and every other signal about it says healthy, so a
  zero tool count gets its own sentence and an uncounted one stays absent.
- **A status this build cannot map is not a fault.** The CLI's status words are a third party's
  vocabulary; an unrecognised one records as `unknown` and is rendered neutrally, because painting
  it red would send an operator to debug a working integration each time a CLI adds a word.

Nothing branches on an observation: this is evidence for a person, not a control signal.
Correspondingly it rides all three poll dispositions rather than just the live one — a job short
enough to settle between two polls is never seen running, and a job that fails is the one whose
post-mortem needs this most.

Runner-pool operators who proxy the executor-harness verbatim gain
`response.toolServersPath` on the manifest; leaving it unset costs the diagnostic and never
produces a false one. Ships with runner image 1.95.0.
