import { defineConfig } from 'drizzle-kit'

// drizzle-kit config: the single source of truth for the Postgres schema is
// `src/db/schema.ts`. `pnpm db:generate` diffs it against the committed migration
// lineage in `drizzle/` and emits the next SQL migration + journal snapshot. The
// service applies that lineage at boot via the drizzle migrator (see src/db/migrate.ts),
// so the generated `drizzle/` folder is shipped with the package (package.json `files`).
//
// No `dbCredentials` here: generation is offline (a pure schema diff) and we never run
// `drizzle-kit push`/`migrate` against a live DB from this config — boot-time migration
// owns application, keeping the production image free of the CLI.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
