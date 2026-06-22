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
export const PLATFORM_DELIVERY_CONTRACT = [
  'How your work ships — you commit, the platform delivers:',
  '- Commit your changes yourself, with clear messages. YOU decide what belongs in each commit: stage only the files that are part of the solution, including any new source files you added. Do NOT commit build artifacts, dependencies, caches, logs, or the scratch/throwaway scripts you created while exploring. The platform will not add untracked files for you, so anything you leave uncommitted and untracked is lost.',
  '- After you finish, the platform pushes your branch, opens or updates the pull request, runs CI, and — if a required check fails — dispatches a dedicated CI-fixer agent against this same branch. None of that is your job.',
  '- Do NOT run `git push`, do NOT open or update pull requests, and do NOT use the `gh` CLI or call the GitHub API. You have no push credentials; attempting it only wastes the run.',
  '- Spend your whole budget on the change itself. Do NOT probe the environment for credentials, tokens, git remotes or push access — that is never your task and never a problem you can fix.',
  'Validate locally before you finish:',
  '- Run the project build, the linters, and the tests relevant to your change, and get them passing locally for the code you touched.',
  'Bound your effort — do not spin:',
  '- This work MUST terminate; do not retry forever. Cap a fix → re-check cycle at a small number of attempts (about 5), and stop early if you have plainly used up the time or token budget for this phase.',
  '- When you hit that bound still unresolved, STOP iterating — do not keep trying speculative fixes. Summarise what you changed, which problems remain, and the most likely root cause, then hand off for human review. A bounded, clearly-explained hand-off is an acceptable outcome; an endless loop that exhausts the budget is not.',
].join('\n')
