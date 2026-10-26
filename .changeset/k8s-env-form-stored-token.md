---
'@cat-factory/app': patch
---

Editing a saved Kubernetes environment connection no longer asks for the token again to save: a blank field keeps the saved token. Test connection still needs the token typed, and the field help says so.
