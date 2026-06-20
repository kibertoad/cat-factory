---
'@cat-factory/app': patch
---

Add a "Connect a source" button to the add-task popup's context picker.

The `ContextPicker` (the "Extra context" section of the add-task modal) now offers
an explicit **Connect a source** dropdown listing every configured document/issue
source, so a user can set up (or reconnect) an integration without leaving the
popup — previously connecting was only reachable by selecting an unconnected source
from the source dropdown. Connecting refreshes the picker in place once the source
comes online.
