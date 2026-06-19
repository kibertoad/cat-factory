-- Resizable service frames.
--
-- A block may carry an explicit, user-set pixel size (set by dragging a service
-- frame's borders, Miro-style). Null means the board auto-sizes the frame from its
-- contents; a non-null (width, height) pair is the dragged size. Both columns move
-- together (set/cleared as a unit), mirroring pos_x/pos_y.
ALTER TABLE blocks ADD COLUMN width REAL;
ALTER TABLE blocks ADD COLUMN height REAL;
