---
'@cat-factory/app': minor
---

Redraw the basic/advanced nav line by route count. A destination is now `advanced` only when
basic mode reaches its capability another way (a Workspace-settings tab, the Integrations hub)
or when it sits beside the delivery path (Sandbox, Kaizen). The pipeline builder, fragment
library, Infrastructure and Environment-setup windows, Operator dashboard and Reports were each
the SOLE route to their capability, so basic mode was hiding the capability rather than trimming
the surface; they are visible in both tiers now, still behind their unchanged RBAC gates.
