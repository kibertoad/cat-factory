-- Per-block selection of best-practice prompt fragments. Stored as a JSON array
-- of fragment ids (TEXT), mirroring the existing `features` column; (de)serialised
-- in the repository mappers. Nullable: existing blocks have no selection.
ALTER TABLE blocks ADD COLUMN fragment_ids TEXT;
