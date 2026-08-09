---
---

Add `@cat-factory/acceptance`, a hand-run acceptance suite against a live local deployment with
nothing faked. It refuses before spending anything when the deployment is not ready, naming every
unsatisfied prerequisite with the steps and commands that fix it, records its
progress where a second command can read it, and resumes an interrupted pass by adopting what the
previous attempt left rather than re-filing it. Test-only: the package is private and no versioned
package changes.
