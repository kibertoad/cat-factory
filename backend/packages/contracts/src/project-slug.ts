import * as v from 'valibot'

/** The slug project stages, outcome streams, outcome intents and acceptance criteria are named with. */
export const projectSlugSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9-]{0,39}$/, 'must be a lowercase slug'),
)
