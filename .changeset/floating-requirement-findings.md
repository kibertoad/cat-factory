---
'@cat-factory/app': minor
---

Order the requirements-review findings by what still needs a reaction: unanswered findings and
Writer suggestions awaiting accept/reject float to the top, findings whose suggestion is still
being generated sit below them, and everything already answered or dismissed sinks to the bottom
(severity remains the order within each group). The list is labelled once it spans more than one
group, and holds still while an answer is being typed so a card can't slide out from under the
cursor when the auto-save on blur re-sorts it.
