---
'@cat-factory/app': patch
---

Freeze the run-infrastructure spinners once the engine stops driving the run.

A container left `starting` and an environment left `provisioning` (or `tearing_down`) kept
animating for as long as the step overlay stayed open, so a run that had parked or ended read as
a live cold-boot that was simply taking a while. The animations now gate on one shared predicate,
`runIsActive`, which is true only while the engine is actually driving the run: the labels stay
(they are the last thing the provider reported) and the icons stop turning.

That predicate replaces the two hand-rolled `runLive` copies that drove the infrastructure
attempts drawer's background poll, and it is stricter than they were. A run parked on a human
decision (`blocked`) or on an exhausted spend budget (`paused`) counts as inactive, not just a
terminal one, so the drawer no longer re-polls every four seconds against a run that cannot write
another attempt until someone unblocks it. Manual refresh is unchanged and always available.
