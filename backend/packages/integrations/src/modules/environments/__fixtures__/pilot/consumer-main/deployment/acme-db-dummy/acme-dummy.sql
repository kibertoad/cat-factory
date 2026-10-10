-- Sanitized fixture — a full seed/dummy data dump. The detector ranks this ABOVE the
-- pre/schema-only sibling (`acme-pre-dummy.sql`) and pre-selects it as the seed step.
-- Content is a placeholder; only the `.sql` name + `deployment/*-db-dummy/` location matter.
INSERT INTO projects (id, name) VALUES (1, 'demo');
