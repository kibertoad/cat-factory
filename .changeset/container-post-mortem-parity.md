---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
---

Say what killed a container, on every transport that can run one.

The post-mortem machinery was wired into exactly one path (the local per-run poll), so on the
DEPLOYED runtime a container death reached the operator as `Job not found (container evicted or
crashed)` and nothing else. Each of the three remaining transports already held the evidence and
discarded it at the moment it became the only evidence there was.

**Cloudflare.** A per-run container recorded only a rollout drain, so an OOM kill recorded
nothing. It now records `{ exitCode, reason }` for EVERY stop, and the transport attaches it to
the eviction detail. That state is deliberately a SECOND, independent half of the stop record: the
churn cause decides the recovery budget (unchanged, so the crash-eviction backstop behaves exactly
as before), while the exit state decides the detail and is kept for the cause-less deaths, which
are precisely the ones nobody could diagnose. The two hooks that see a stop now merge onto one
record instead of overwriting: `onError` recognises the churn and knows no exit code, `onStop`
knows the exit code and cannot name the churn, and they fire in either order. What this runtime
cannot supply is a log tail: a Container's stdout goes to the deployment's Workers logs and no API
returns it to the Durable Object, so the detail says where the output actually is rather than
implying it was withheld.

**Kubernetes.** The pod object outlives its workload (`restartPolicy: Never`), so the kubelet's
account of the death was one GET away and never read. The 404 poll now reads `state.terminated`,
falls back to `lastState.terminated` for a container between lives (where a crash loop's real
cause sits), and adds the pod-level reason on top rather than instead, since a kubelet eviction
under node pressure names itself only there and the container never saw it. A pod that is GONE and
a pod that could not be READ are reported as themselves, because an unreachable control plane must
not read like a clean death.

**The native host-process transport** was spawned `stdio: 'ignore'`, discarding both the exit code
and the stderr the harness routes its warn/error lines to. It now keeps a bounded stderr tail
(nothing is forwarded onward, so the developer's console is as quiet as before) and retains the
last exit past the process handle, which is dropped before the poll that needs it. Because this
backend outlives a run, the tail is attached only when the process is confirmed gone; a live
process that merely forgot the job says so, the same rule the warm pool follows. The same tail is
folded lazily into a dispatch that never got the harness healthy, so a harness that will not boot
at all stops failing with a sentence that names only the symptom.

Kernel gains `composePostMortem`, the one place the two obligations every such detail carries
(scrub through `redactSecrets`, then cap and state what was dropped) are implemented; the local
container transport's two composers now go through it.

Internal break: the per-run container's `recentEvictionCause` RPC is replaced by
`recentStopObservation`, which answers both halves. Worker and container deploy together, so
nothing spans the change.
