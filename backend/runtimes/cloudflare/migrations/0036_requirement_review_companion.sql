-- The quality companion's verdicts on the reworked requirements document — a JSON
-- ARRAY of { rating, threshold, passed, feedback } objects, one per rework cycle (the
-- full correction history, latest last). Below the threshold the rework is not accepted
-- (the review stays `ready`) and the feedback is surfaced + fed into the next rework.
-- Null until a rework has been gated.
ALTER TABLE requirement_reviews ADD COLUMN companion TEXT;
