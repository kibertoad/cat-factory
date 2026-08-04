---
'@cat-factory/app': minor
---

Reusable operations, slice 3: the create-task type picker groups a registered catalog instead of
flattening it into one row.

The picker was a single wrap of buttons, which is right for the handful of built-in types and wrong
the moment a deployment registers a catalog of reusable operations: an org with twenty of them turns
the row into a wall in which the everyday `feature` / `bug` choices are no longer findable. Custom
task types have declared `presentation.category` since slice 1 and nothing read it; now it lays the
picker out as rows. Built-ins come first in one uncaptioned row (the everyday loop stays where it has
always been), then one captioned row per category in REGISTRATION order (the only order the
deployment expressed, so not re-sorted alphabetically), then any uncategorized custom types in a
trailing flat row.

`presentation.description` is rendered for the first time too, though the schema has promised it to
the picker all along: as each custom button's tooltip, which is what helps you choose, and as a hint
line under the picker once a type is selected, which is the half a touch device can reach. Both are
deployment-authored English rendered verbatim, so no descriptor string enters a locale catalog and
this slice adds no i18n keys.

The layout rule is a pure function (`utils/taskTypePicker.ts`, the `buildFragmentCategoryGroups`
sibling) rather than inline template logic, because the row ORDER is the behaviour worth pinning and
a rule inside an SFC is only reachable by mounting one. Deliberately absent: collapsing, an overflow
menu, and any alphabetical re-sort. Each would hide a choice behind a second interaction, and a
catalog needing them has outgrown what a create-task dialog should ask.
