// Shared sanity bound appended to every "keep fixing until CI is green" loop in
// the agent role prompts — the build/implementation gate (standard-prompts), the
// e2e/runnable-tests gate (acceptance-prompts) and the docs gate
// (business-logic-prompts).
//
// On its own, "Repeat that loop until every required check passes — never hand
// off on a red PR" reads as an UNBOUNDED instruction: an agent can burn an
// entire run pushing speculative fixes at a check it cannot make pass, blowing
// the time/token budget with nothing useful to show. This clause caps the loop
// so the agent stops — with a useful hand-off — once it has plainly spent its
// allotted attempts, wall-clock time or token budget, rather than spinning
// indefinitely. The container's own watchdogs (inactivity / max-duration) and
// the workspace spend gate are the hard backstops; this makes the agent bound
// itself first so it ends on a clear summary instead of an abrupt kill.
export const CI_RETRY_SANITY_CHECK = [
  'Sanity bound — this loop MUST terminate; do not retry forever:',
  '- Cap the fix → push → wait-for-CI cycle at a small number of attempts (about 5). Likewise stop early if you have plainly used up the time or token budget allotted to this phase.',
  '- When you hit that bound with CI still red, STOP iterating — do not keep pushing speculative fixes. Instead summarise the unresolved state: which required checks are still failing, what you changed across the attempts, and the most likely root cause, then hand off for human review.',
  '- A bounded, clearly-explained red hand-off is an acceptable outcome here; an endless retry loop that exhausts the budget is not.',
].join('\n')
