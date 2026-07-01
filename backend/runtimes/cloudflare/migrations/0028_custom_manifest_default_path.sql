-- Custom-manifest-type definitions gain a default in-repo manifest path (prefilled + used as
-- the auto-detection seed for a `custom` service's manifestPath) and a fixer-agent prompt (used
-- to generate/fix the manifest). Both optional; mirror the Drizzle `customManifestTypes` columns.
ALTER TABLE custom_manifest_types ADD COLUMN default_manifest_path TEXT;
ALTER TABLE custom_manifest_types ADD COLUMN fixer_prompt TEXT;
