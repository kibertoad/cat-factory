---
'@cat-factory/orchestration': patch
'@cat-factory/node-server': patch
---

Split the three largest source files along cohesive seams and tighten their file-size ratchet
allowances (no behavioural change):

- `RunDispatcher.ts` — the three built-in dispatch registries (step handlers, completion
  interceptors, post-completion/terminal resolvers) move to a new `dispatcher-registries.ts`,
  built from an injected deps seam; the dispatcher keeps ownership via bound call-backs.
- Node `container.ts` — the container-agent-executor wiring (transport resolver, provisioning-log
  wrapper, container executor + repo bootstrapper + env-config repairer, GitHub-issue filer,
  trace-sink builder) moves to a new `container-executor-deps.ts`; the public seams stay exported
  from `container.ts`.
- The conformance `suites/execution.ts` sub-splits into `execution-{tester,review,gates}.ts` with
  `execution.ts` as a thin aggregator (private package; no release impact).
