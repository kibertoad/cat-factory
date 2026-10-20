-- A deep guided-review answer runs in a container; its dispatch (the model it ran and the
-- credential it leased) is recorded on the message so every later poll addresses the same job.
ALTER TABLE guided_review_messages ADD COLUMN investigation TEXT;
