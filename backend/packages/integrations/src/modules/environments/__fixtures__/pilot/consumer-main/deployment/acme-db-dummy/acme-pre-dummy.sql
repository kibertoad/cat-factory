-- Sanitized fixture — a schema/pre dump (DDL only). The detector deprioritizes it
-- (the `pre`/schema tokens lower its rank) so `acme-dummy.sql` wins the pre-selection.
CREATE TABLE projects (id INT PRIMARY KEY, name VARCHAR(255));
