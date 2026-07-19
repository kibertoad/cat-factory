-- Pipeline use-case classifier: persist the `purpose` field. Chosen in the pipeline builder and
-- stamped on every built-in preset, it drives which pipelines a task picker offers (a `document`
-- task offers only `purpose = 'document'`) and which agent kinds the builder palette shows.
--
-- `pipelines.purpose` — one of `'build'` / `'document'` / `'review'` / `'research'` / `'planning'`.
--                       NULL/absent ⇒ UNCLASSIFIED, treated as unrestricted (shown everywhere but
--                       a `document` task), so existing rows read unchanged (pre-1.0, no back-fill).
--                       Built-ins gain their purpose via the version-bumped reseed offer.

ALTER TABLE pipelines ADD COLUMN purpose TEXT;
