-- Enforce the "at most one OPEN notification per (workspace, block, type)" invariant
-- atomically. The service previously upheld it with a racy findOpenByBlock → build → upsert
-- read-before-write, so two concurrent raises (e.g. an indefinitely-polling gate re-raising
-- while the engine raises) could stack duplicate open cards. The partial unique index makes
-- the dedup a single atomic write (see D1NotificationRepository.upsertOpenForBlock's
-- ON CONFLICT … WHERE status='open'). Partial, so dismissed/acted history is unconstrained;
-- block-less cards (NULL block_id) are exempt (NULLs are distinct in a unique index).
CREATE UNIQUE INDEX uniq_notifications_open_block
  ON notifications (workspace_id, block_id, type)
  WHERE status = 'open';
