---
'@cat-factory/app': patch
---

Give Hebrew its own plural selector, and fix Ukrainian's.

Only `pl` and `uk` overrode vue-i18n's built-in plural selector, so `he` ran on the default 2-form
rule: n === 1 took the singular and everything else took the plural. Hebrew has a distinct DUAL,
so every Hebrew count message was an approximation at n === 2, both for the lexical duals
("יומיים" for two days, "פעמיים" for twice) and for the spelled-out numeral prose wants ("שתי
משימות" rather than "2 משימות"). All 84 `he` plural entries are re-authored with the dual form.

Note this is a THREE-form CLDR rule (one/two/other), not the four (one/two/many/other) the
localization doc claimed. The `many` bucket for round tens was retired from CLDR because modern
Hebrew does not inflect for it, and current ICU agrees; authoring a fourth form would have put a
duplicate of `other` in every entry for a translator to keep in sync forever.

Two pre-existing bugs surfaced while pinning the selectors against `Intl.PluralRules`:

- **Ukrainian shared Polish's rule**, but the two differ: Polish reserves `one` for exactly 1,
  while Ukrainian gives it to every count ending in 1 except the teens. 21, 31, …, 101 were
  rendering the `many` form ("21 репозиторіїв" for "21 репозиторій"), 89 of the first 1000 counts.
- **Three `pl`/`uk` entries carried only 2 of the 3 required forms**, so the selector indexed past
  the end of the form array and vue-i18n threw out of `t()`. That blanked the surface rendering
  the message for any count in the `many` bucket (0, 5-21, …), rather than picking a wrong form.
  The missing forms are restored, and the selector now clamps so a short entry can never throw.

The form count an entry carries is load-bearing (one form too few re-points every remaining slot
onto a different count), and neither existing i18n gate can see it: the key exists and it moved
with `en`, which is all they check. `i18n/plural-forms.spec.ts` closes that gap.
