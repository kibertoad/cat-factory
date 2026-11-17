---
'@cat-factory/app': patch
---

The failure block on a failed run offers its setup fix ("Configure AI", "Configure runner pool", the environment settings) only to a caller who can save it. A member, a viewer or the designer surface gets one line naming who can fix the gap instead of a button that opens a screen whose save is refused. The rule is the one the run-start conflict toasts use, now shared from `utils/setupFixes.ts`.
