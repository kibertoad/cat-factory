---
'@cat-factory/app': patch
---

Localize the integration surfaces (phase 6 of the app i18n migration).

All user-facing copy in the `github/**`, `slack/**`, `documents/**` and `tasks/**`
components now resolves through `@nuxtjs/i18n` instead of hard-coded strings, under the
`github.*`, `slack.*`, `documents.*` and `tasks.*` namespaces:

- GitHub: the onboarding gate (`GitHubOnboarding`), the installation connect flow
  (`GitHubConnect`), the integration panel with repos/pulls/issues browsing
  (`GitHubPanel`), the add-service-from-repo modal (`AddServiceFromRepoModal`), and the
  repo tree browser (`RepoTreeBrowser`).
- Slack: the routing/members panel (`SlackPanel`), including the routable
  notification-type labels and role options.
- Documents: the context-document picker, import modal, source-connect modal, spawn
  preview, and the task context-docs list.
- Tasks: the context-issue picker, task context-issues list, import modal, and the
  source-connect modal.

New keys ship in all five bundled locales (en/es/fr/pl/uk), in full key parity. Count
readouts use plurals with the correct forms (3-form one/few/many for pl/uk); statically
known enum labels (PR/issue state, Slack notification types) resolve via literal `t(...)`
keys so the typed-message-key drift guard stays live; and structural emphasis uses
`<i18n-t>` slots rather than HTML in message bodies. A few icon-only buttons gained
`aria-label`s in the process.
