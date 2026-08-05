---
'@cat-factory/app': patch
---

Fix a white screen on the very first launch, for a user with no saved tutorial answer.

The board page's tutorial launch offer reads `startupAdvisoryOpen` from a watcher with
`immediate: true`, so that getter runs synchronously during `setup()`. Two of the values it folds in
(`needsGitHubInstall`, `githubProbePending`) were declared further down the same script block, so the
first evaluation hit their temporal dead zone and threw `ReferenceError: can't access lexical
declaration 'needsGitHubInstall' before initialization`, taking the whole page down. The two
`computed`s move above the offer that consumes them; nothing else changes.

Only a first-ever launch could reach it: any saved decision short-circuits `tutorialOfferSettled()`,
so the watcher never registers and the getter never runs early. And only a DEV build shows it,
because Vue rethrows an unhandled watcher error in development and merely logs it in production,
where the computed recovers on its next evaluation. That pair is why the e2e suite stayed green: it
drives a production build, and every spec but the tutorial one pre-answers the prompt.
