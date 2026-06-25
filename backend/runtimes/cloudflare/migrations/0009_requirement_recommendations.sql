-- Requirement-Writer recommendations: a first-class JSON collection on a requirements
-- review (NOT on items, which churn each re-review). Each entry snapshots its source
-- finding by title/detail, carries the suggested answer text, an accept/reject status, an
-- optional re-request note, and an optional `groundedInFragment` marker when the answer was
-- taken straight from a best-practice fragment. Pre-1.0: existing rows default to '[]'.
ALTER TABLE requirement_reviews ADD COLUMN recommendations TEXT NOT NULL DEFAULT '[]';
