import { basename, posix } from 'node:path'
import { slugifyProjectName } from './slug.js'

/** Where the scaffold writes the deployment's compose file, relative to the project root. */
export const COMPOSE_FILE_PATH = 'local/docker-compose.yml'

/**
 * The project name Compose falls back to when a compose file declares none: the file's own
 * directory. Every scaffolded deployment keeps its compose file in the same place, so this one
 * name is what any deployment with an undeclared project is running under.
 */
const COMPOSE_DIRECTORY_DEFAULT = posix.dirname(COMPOSE_FILE_PATH)

/**
 * The Compose project name for a scaffolded deployment, complete with its suffix so the value is
 * assembled in exactly one place. It keys the deployment's Postgres container, its network and
 * its `<project>_cat-factory-pg` database volume.
 *
 * Derived from the DEPLOYMENT DIRECTORY, which is the field a user varies per deployment
 * (`--dir`, or the project name when `--dir` is omitted). The project name on its own would not
 * do: it defaults to a constant that `-y` and a bare Enter both take, so two deployments would
 * still meet in one project. Two deployment directories that share a basename do still collide,
 * one level up from where Compose's own default (the compose file's `local/` directory, shared by
 * every deployment) collided.
 *
 * Compose accepts `[a-z0-9][a-z0-9_-]*`, so a dot becomes `_` rather than `-`: folding it onto a
 * hyphen would map `acme.site` and `acme site` onto one project, which is the collision the name
 * exists to prevent. The npm slug it starts from never begins with `.`, `_` or `-`, so the result
 * satisfies Compose's first-character rule.
 */
export function composeProjectNameFor(deploymentDir: string, fallback: string): string {
  const slug = slugifyProjectName(basename(deploymentDir), fallback).replace(/\./g, '_')
  return `${slug}-local`
}

/**
 * What a regenerate owes the operator: the Compose project the deployment already in the target
 * directory runs under, once rewriting its compose file moves it to a different one. Returns
 * `undefined` when the name does not move, which is every fresh scaffold and every plain rerun.
 *
 * Without this the containers and the database volume are simply left behind under a name nothing
 * prints: `npm run db:down` no longer reaches them, the old container keeps the published
 * Postgres port until it is stopped, and the board comes up on an empty database.
 */
export function orphanedComposeProjectNote(
  existingCompose: string,
  nextName: string,
): string | undefined {
  const previous = declaredComposeProject(existingCompose) ?? COMPOSE_DIRECTORY_DEFAULT
  if (previous === nextName) return undefined
  return [
    `The deployment already in this directory runs under Compose project "${previous}"; it now`,
    `declares "${nextName}". Its container and its "${previous}_cat-factory-pg" volume stay`,
    'behind under the old name, out of reach of `npm run db:down`, and while that container runs',
    'it holds the published Postgres port:',
    '',
    `    docker compose -p ${previous} down     # add -v to delete that database as well`,
    '',
    `Afterwards \`npm run db:up\` brings up a FRESH database under "${nextName}".`,
  ].join('\n')
}

/** The top-level `name:` a compose file declares, if any (quoted or bare). */
function declaredComposeProject(compose: string): string | undefined {
  return /^name:[ \t]*['"]?([^'"\s#]+)/m.exec(compose)?.[1]
}
