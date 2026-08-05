---
---

Tooling only: fix the Python SDK emitter shadowing its own `dataclasses.field` import. No version
bump, because the broken output never shipped: the first wire property named `field` arrives in
this same change (the input gate's `PublicInputGateDecisionIssue`), so no published artifact
carries the defect.

The property was emitted as a class attribute above the `extra` bag's `field(default_factory=dict)`
call. The attribute bound `field` in the class namespace, the call became `None(...)`, and because
`cat_factory/__init__.py` reaches models through `client` and `operations`, EVERY import of the
package raised `TypeError`, not just the one model's.

The `extra` line now calls `dataclasses.field`. It is the only executable expression in a generated
class body, so it is the only name a wire property can shadow: the decorator is evaluated at module
scope before the body binds anything, and annotations are strings under
`from __future__ import annotations`.

Regenerate-and-diff structurally cannot catch this class of bug, since the emitter is consistent in
both halves. The guard is `sdk/python/tests/test_models.py`, which imports the real generated module
and round-trips the shape that broke it.
