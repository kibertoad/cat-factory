-- The pull request a block's implementation ("implementer") agent opened for its
-- work: a small JSON ref ({ url, number?, branch? }) recorded on a task once its
-- container agent pushes a branch and opens a PR. Stored as TEXT and
-- (de)serialised in the repository mappers. Nullable: blocks with no PR yet.
ALTER TABLE blocks ADD COLUMN pull_request TEXT;
