---
'@cat-factory/app': patch
---

UX papercuts — async state, realtime & error surfacing (section E, UX-70..UX-77)

- **UX-70 (P1): a board that never goes live is no longer silently frozen.** After a few
  failed initial WebSocket handshakes (proxy/firewall blocking WS while REST works, or a
  ticket-mint failure), `useWorkspaceStream` flags the connection as failed and
  `ConnectionStatusBanner` shows a distinct "not receiving live updates" strip — separate
  from the amber reconnecting strip (which only appears once we've actually been live).
- **UX-71 (P2): a `board` event's coarse refresh no longer silently swallows failures.**
  It now retries with backoff (aborting on stream-stop / workspace-switch), so one
  transient failure can't leave the board stale (a materialised module never appearing).
- **UX-72 (P2): a reconnect that fails to reconcile now retries.** The on-open resync uses
  the same retrying refresh instead of a swallowed `.catch(() => {})`, so a reconnect no
  longer presents as fully live while missing everything from the outage. `connected` is
  still announced even if every retry fails (we are connected).
- **UX-73 (P2): a `starting` preview no longer wedges on a transient poll error.** The
  preview store keeps polling through blips up to a small cap (self-heals when the runtime
  recovers), then surfaces the error and stops — instead of leaving the amber "Starting…"
  spinning forever with no recovery.
- **UX-74 (P2): the service-spec window's error state has a Retry.** No more
  close-and-reopen as the only escape.
- **UX-75 (P3): the observability panel distinguishes a context-load failure from an empty
  run.** A failed provided-context load now shows an error-with-retry state instead of
  masquerading as "no context stored"; the model-activity error state also gained a Retry.
- **UX-76 (P3): `removeDependency` surfaces failures.** It's wrapped in try/catch like its
  sibling `toggleDependency`, toasting on failure instead of rejecting unhandled.
- **UX-77 (P3): actionable error toasts are sticky.** The "Configure AI" / "Configure
  storage" remedy toasts no longer auto-dismiss and take their one-click fix with them.
