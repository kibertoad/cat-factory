-- Per-preset provider preference.
--
-- `provider_preference` is the order a preset's runs prefer a model's routes in (its
-- `ModelFlavor`s, most preferred first), stored as a JSON array. It REORDERS and never
-- filters: routes the list omits are appended in the default order and tried last, so a
-- preset naming three flavours cannot make a model whose only route is the fourth
-- unresolvable. NULL (and an empty array) mean the deployment's default order, which is
-- what every pre-existing row keeps.
ALTER TABLE model_presets
  ADD COLUMN provider_preference TEXT;
