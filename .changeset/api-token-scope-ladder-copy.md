---
'@cat-factory/app': patch
---

The API token scope picker now says what each level includes. Each label names the level it builds on (Write includes Read, Decide includes Write, Full access includes Decide), and the help text lists what every level adds, including Decide, which it previously left out: answering a run's human decisions, which a token also needs to start a pipeline that can stop for one. Updated in every locale.
