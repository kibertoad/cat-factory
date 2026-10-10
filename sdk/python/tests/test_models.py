"""The generated models, exercised as a Python module rather than as text.

`pnpm check:sdk` regenerates the clients and diffs them, which proves the committed files match
the emitter. It cannot prove the emitter is RIGHT: a bug that is consistent in both halves passes
a regenerate-and-diff check unread. This file is the other half of that guard, and it only has to
import the package to do most of its job.

The case that earned it: a wire property named `field`. The emitter declared it as an attribute
and then, further down the same class body, called the bare `field` it had imported from
`dataclasses` to build the `extra` bag. The attribute shadowed the import, the call became
`None(...)`, and because `cat_factory/__init__.py` reaches models through `client` → `operations`,
EVERY import of the package raised `TypeError` — not just this one model's.

So the assertions here are deliberately about SHAPE, not about a value list that would have to be
re-pinned on every additive release: that a model whose property collides with the emitter's own
imports is constructible, and that it survives the round trip both directions.
"""

from __future__ import annotations

import dataclasses

from cat_factory.models import (
    PublicInputGateDecisionIssue,
    PublicInputGateDecisionIssueField,
)


def test_a_property_named_after_the_emitters_own_import_is_constructible() -> None:
    """`field` is a plausible API name, and it is the emitter's own import. Both must work."""
    issue = PublicInputGateDecisionIssue(
        code="required_field_missing",
        severity="blocking",
        field=PublicInputGateDecisionIssueField(key="impact", label="Customer impact"),
    )
    assert issue.field is not None
    assert issue.field.key == "impact"
    # The `extra` bag is what the shadowed call was building. An instance that omits it must
    # still get its own empty dict rather than a shared one, which is the whole reason the
    # emitter reaches for `default_factory` instead of a plain `{}` default.
    assert issue.extra == {}
    assert PublicInputGateDecisionIssue(code="description_missing", severity="advisory").extra == {}


def test_the_default_factory_survived_the_qualification() -> None:
    """Not just "it imports": the `extra` bag must still be a per-instance default_factory."""
    spec = {f.name: f for f in dataclasses.fields(PublicInputGateDecisionIssue)}["extra"]
    assert spec.default_factory is dict
    assert spec.default is dataclasses.MISSING


def test_a_colliding_property_round_trips_both_directions() -> None:
    decoded = PublicInputGateDecisionIssue.from_dict(
        {
            "code": "required_field_missing",
            "severity": "blocking",
            "field": {"key": "impact", "label": "Customer impact"},
            "somethingNewer": 7,
        }
    )
    assert decoded.field == PublicInputGateDecisionIssueField(key="impact", label="Customer impact")
    # An unknown key is RETAINED, not dropped: the additive-forever contract the module docstring
    # promises. Asserting it here (rather than that the key set equals some list) keeps the test
    # from failing on the next field the API adds.
    assert decoded.extra == {"somethingNewer": 7}

    encoded = decoded.to_dict()
    assert encoded["field"] == {"key": "impact", "label": "Customer impact"}
    assert encoded["code"] == "required_field_missing"

    # An absent optional stays ABSENT rather than encoding as null, so a partial update never
    # reads as "clear this".
    bare = PublicInputGateDecisionIssue(code="description_missing", severity="advisory")
    assert "field" not in bare.to_dict()
