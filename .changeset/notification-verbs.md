---
'@cat-factory/app': patch
---

An inbox card that asks a person for something now carries its verb as the primary button ("Answer" for a parked decision, "Review", "Test", "Triage" and so on), and "Mark read" becomes a secondary button. Cards whose own action is already the verb (Merge, Retry run, Acknowledge) are unchanged. A parked agent question now opens the decision window from the inbox, where it can be answered, instead of the read-only step detail; an approval gate still opens the step to approve. Any verb whose window cannot open (its run is not loaded or not parked, as after a Ralph loop or a gate that gave up) says "Open", because it only opens the task. "Mark read" is an outline button beside the verb, so it no longer looks like "Dismiss". The inbox closes when a card opens something. Each type's verb and destination now sit in one route table (`utils/notificationRoutes.ts`), which the title link uses too.
