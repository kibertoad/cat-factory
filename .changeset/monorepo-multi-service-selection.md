---
'@cat-factory/app': patch
---

Add-service-from-repo: multi-select services from a monorepo in one pass. The
monorepo directory picker now accumulates a cart of directories — pick several
from any parent folder without losing earlier picks, remove any, then add them
all at once. Directories that already back a service on the board are shown but
disabled, and the add action sits directly beside the selection cart.
