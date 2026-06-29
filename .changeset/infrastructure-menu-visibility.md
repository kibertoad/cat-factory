---
'@cat-factory/app': patch
---

fix(app): always show the Infrastructure navbar menu and its backend selectors. The menu and the tabbed window were still gated on the old provider-connection probes (a registered runner-pool / environment connection) or local mode, so on a Worker or Node deployment with neither connection wired the Infrastructure entry disappeared entirely and the execution-backend selector was unreachable. Both now key off the deployment's `auth.infrastructure` capability descriptor (populated by every facade), so the execution + test-environment backend selectors always render; the optional runner-pool / environment connect forms still gate on their own availability probe.
