-- Whether a `ready` environment can actually be REACHED, beside the one string that names it.
--
-- `url` has always been a claim nobody verified: a tester handed a name it cannot resolve reports
-- the environment as dead, which is the wrong layer and the expensive answer. This column holds
-- the addresses a provider states carry traffic for that name, plus what dialling them proved.
--
-- In the clear, unlike its `*_cipher` neighbours: a list of addresses for a host already published
-- in plaintext beside it is neither a credential nor arbitrary provider state.
ALTER TABLE environments ADD COLUMN reachability TEXT;
