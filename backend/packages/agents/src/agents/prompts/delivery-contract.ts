// The shared delivery contract appended to every container coding-agent role that
// works on a real checkout and ships its result through a pull request — the build
// (standard-prompts), the runnable-tests / e2e (acceptance-prompts) and the docs
// (business-logic-prompts) gates.
//
// These agents run inside an ephemeral container with NO push credentials: the
// platform owns version control (push + PR) and the CI loop. Earlier prompts told
// the agent to "open or update the pull request, push the fix, and wait for CI" —
// but the agent cannot push (the GitHub token never enters its shell) and was never
// meant to. That instruction was actively harmful: a capable model took it
// literally, tried to `git push`, hit an auth wall, and then burned the ENTIRE run
// probing env vars, decoding tokens and poking at git remotes instead of doing the
// work (the run shipped zero changes and failed with "no file changes"); weaker
// models simply gave up. This contract makes the boundary explicit so the agent
// spends its whole budget on the change and never chases credentials.
//
// Commit ownership stays with the AGENT: only it knows which files are part of the
// solution versus scratch scripts / build artifacts it created while exploring, so
// it selects and commits its own work. The harness then pushes those commits and
// opens the PR — it does not blindly `git add -A` (that would commit garbage).
//
// COMMIT AS YOU GO is stated as its own bullet because the contract already said the platform
// publishes commits periodically "so nothing is lost if this container dies" and an agent read
// that as a promise about its working tree rather than about its commits. In the measured run
// behind it, the coder made zero commits in six and a half minutes, batched everything to the end,
// and was killed with the whole deliverable still uncommitted. The checkpoint push can only
// publish what exists, so the frequency of commits is the agent's half of that guarantee.
//
// The APPEND-ONLY rule below is the half this contract was missing. The harness
// checkpoint-pushes the agent's commits about once a minute so an evicted container
// doesn't lose them, which makes a commit PUBLISHED within a minute of being made,
// something the agent has no way to observe. Amending or resetting one after that is
// ordinary git hygiene, and the "validate locally before you finish" instruction below
// is exactly what leads an agent to commit, run the tests, fix, and amend. The harness
// now leases its force push so its OWN checkpoint can be rewritten (see
// `createWorkBranchPusher`), but a rewrite of commits an EARLIER run published still
// costs a refused push and a re-dispatch, so the rule is stated rather than inferred.
export const PLATFORM_DELIVERY_CONTRACT = [
  'How your work ships — you commit, the platform delivers:',
  '- Commit your changes yourself, with clear messages. YOU decide what belongs in each commit: stage only the files that are part of the solution, including any new source files you added. Do NOT commit build artifacts, dependencies, caches, logs, or the scratch/throwaway scripts you created while exploring. The platform will not add untracked files for you, so anything you leave uncommitted and untracked is lost.',
  '- COMMIT AS YOU GO, not at the end. The moment a coherent chunk of the work stands on its own, commit it and carry on; do not batch the whole change into one commit after everything is finished. This run can be stopped at any point (a budget, a timeout, an evicted container), and what is committed survives while what is only in the working tree may not. Several honest commits are a better outcome than one perfect commit you never got to make.',
  '- Add commits; never rewrite them. The platform publishes your commits to the branch WHILE you work (it pushes them periodically so nothing is lost if this container dies), so treat every commit you have made as already published: do NOT `git commit --amend`, `git reset` a commit away, `git rebase`, or otherwise rewrite history. If you need to change something you already committed, make another commit on top. A messy-but-honest history is fine; a rewritten one can cost the run its delivery.',
  '- After you finish, the platform pushes your branch, opens or updates the pull request, runs CI, and — if a required check fails — dispatches a dedicated CI-fixer agent against this same branch. None of that is your job.',
  '- Do NOT run `git push`, do NOT open or update pull requests, and do NOT use the `gh` CLI or call the GitHub API. You have no push credentials; attempting it only wastes the run.',
  '- Spend your whole budget on the change itself. Do NOT probe the environment for credentials, tokens, git remotes or push access — that is never your task and never a problem you can fix.',
  'Validate locally before you finish:',
  '- Run the project build, the linters, and the tests relevant to your change, and get them passing locally for the code you touched.',
  'Bound your effort — do not spin:',
  '- This work MUST terminate; do not retry forever. Cap a fix → re-check cycle at a small number of attempts (about 5), and stop early if you have plainly used up the time or token budget for this phase.',
  '- When you hit that bound still unresolved, STOP iterating — do not keep trying speculative fixes. Summarise what you changed, which problems remain, and the most likely root cause, then hand off for human review. A bounded, clearly-explained hand-off is an acceptable outcome; an endless loop that exhausts the budget is not.',
].join('\n')
