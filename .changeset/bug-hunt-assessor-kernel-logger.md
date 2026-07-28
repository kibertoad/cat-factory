---
'@cat-factory/orchestration': patch
---

Log the bug-hunt ranking failure through the kernel `Logger` port. `BugHuntAssessorServiceDeps`
still declared the retired pre-port local logger shape (`warn(obj, msg?)`), which no longer
structurally matches the port every facade actually wires — so the deployment logger could not be
passed and the package failed to build.
