-- Custom workspace metadata: the values for the metadata FIELDS a deployment declares in
-- its app (an external-tool URL resolver reads them to open the tool already scoped to this
-- workspace). One JSON object per workspace on the existing settings row rather than a table
-- of key/value pairs: the whole bag is always read together, always written together, and is
-- bounded (64 entries) by the contract.
--
-- Nullable with no default, which is how every other JSON column on this table spells "no
-- value" (`task_limit_per_type`); the repository reads a missing/garbled blob as `{}`.
ALTER TABLE workspace_settings ADD COLUMN metadata TEXT;
