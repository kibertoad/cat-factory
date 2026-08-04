---
---

Fix the Python SDK emitter shadowing `dataclasses.field`. A wire property may legitimately be
NAMED `field` (`PublicInputGateDecisionIssue.field` is the first), and a dataclass attribute of
that name shadows the import inside the class body, so the `extra` line below it called the
attribute's `None` default instead of `dataclasses.field` and the whole module failed to import.
The emitter now aliases the import (`field as _dc_field`), which also keeps it out of the
module's public surface. Generated-code fix, so no runtime package changes.
