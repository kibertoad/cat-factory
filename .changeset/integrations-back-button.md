---
'@cat-factory/app': patch
---

Add a "Back to Integrations" control to every integration sub-panel opened from the
Integrations hub. Picking a row used to close the hub and reveal that integration's own
panel (GitHub, Slack, vendors, OpenRouter, local runners, document/task sources, the
provider/observability connections, the tracker settings tab) with no way back: the only
exit was the close button, which dropped you to the board. Each panel's modal header now
renders a back arrow next to its title that closes the panel and reopens the hub.

The control only shows when the panel was actually reached from the hub. A new
`ui.cameFromIntegrations` flag is set by `ui.openFromIntegrations` (the hub's row handler)
and cleared by every direct `open*` action, so panels opened from the command bar,
sidebar, a banner or an inspector link don't grow a dead Back. The shared
`IntegrationBackTitle` component renders the title + optional back arrow in the modal's
`#title` slot.
