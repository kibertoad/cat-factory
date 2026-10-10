-- Pre-existing branches of a task's primary target repo handed to the run as input: one
-- optional `working` branch the run keeps building inside (instead of minting
-- `cat-factory/<blockId>`) plus any number of read-only `reference` branches. Serialized JSON
-- array of { name, mode: 'reference' | 'working' }. See docs/initiatives/apriori-branches.md.
ALTER TABLE blocks ADD COLUMN apriori_branches TEXT;
