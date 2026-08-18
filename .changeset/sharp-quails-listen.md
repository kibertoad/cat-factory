---
'@cat-factory/app': patch
---

Close the second round of the same defects the P1 papercut slice left behind. The shared confirm
dialog now joins the app's overlay stack and writes its own `open` on dismissal, so Escape cancels
the discard prompt instead of the result window swallowing the key and leaving a dialog on screen
that resolves nothing. Three unsaved-guard snapshots were wrong in both directions and now report
exactly what their submit button would send. The two interview windows share one draft seam that
settles each answer independently, names how many were lost, and withholds Submit when a write
failed, instead of abandoning every answer after the first failure. A pending confirm locks the
screen that raised it, so a second Delete click can no longer supersede the prompt already open and
silently skip a deletion. The binary-candidates gate stops double-toggling on a label click, states
"no run to read" rather than claiming the run compared nothing, and sequences its loads so a slow
failure cannot report over candidates already on screen.
