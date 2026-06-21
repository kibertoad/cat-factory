-- The quality companion's verdict on the last reworked requirements document — a JSON
-- object { rating, threshold, passed, feedback }. Below the threshold the rework is not
-- accepted (the review stays `ready`) and the feedback is surfaced + fed into the next
-- rework. Null until a rework has been gated.
ALTER TABLE requirement_reviews ADD COLUMN companion TEXT;
