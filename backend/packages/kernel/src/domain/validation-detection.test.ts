import { describe, expect, it } from 'vitest'
import { detectValidationChecks, type RepoSurface } from './validation-detection.js'
import { DEFAULT_VALIDATION_DETECTORS } from './validation-detectors.js'

/**
 * Build a repo surface from a `{ name: content }` map. A `null` value is a file whose content
 * the reader did not fetch (presence-only), and a name ending in `/` is a directory.
 */
function surface(entries: Record<string, string | null>): RepoSurface {
  const files: Record<string, string> = {}
  const list = Object.entries(entries).map(([name, content]) => {
    if (content !== null && !name.endsWith('/')) files[name] = content
    return name.endsWith('/') ? { name: name.slice(0, -1), type: 'dir' } : { name, type: 'file' }
  })
  return { entries: list, files }
}

const detect = (entries: Record<string, string | null>) =>
  detectValidationChecks(surface(entries), DEFAULT_VALIDATION_DETECTORS)

const pkg = (manifest: Record<string, unknown>) => JSON.stringify(manifest)

describe('detectValidationChecks', () => {
  it('recognises nothing in an empty repo', () => {
    expect(detect({})).toEqual({ ecosystems: [], checks: [], truncated: false })
  })

  describe('node', () => {
    it('suggests the declared scripts through the lockfile’s package manager', () => {
      const result = detect({
        'package.json': pkg({
          scripts: {
            lint: 'eslint .',
            typecheck: 'tsc --noEmit',
            test: 'vitest run',
            build: 'tsc -b',
          },
        }),
        'pnpm-lock.yaml': null,
      })
      expect(result.ecosystems).toEqual(['node'])
      expect(result.checks).toEqual([
        { label: 'install', command: 'pnpm install --frozen-lockfile' },
        { label: 'lint', command: 'pnpm run lint' },
        { label: 'typecheck', command: 'pnpm run typecheck' },
        { label: 'build', command: 'pnpm run build' },
        { label: 'test', command: 'pnpm run test' },
      ])
    })

    it('prefers the declared packageManager over the lockfile', () => {
      // Corepack's declaration is the repo's own statement of intent; a stale lockfile from a
      // migration must not override it.
      const result = detect({
        'package.json': pkg({ packageManager: 'yarn@4.1.0', scripts: { test: 'jest' } }),
        'yarn.lock': null,
        '.yarnrc.yml': null,
      })
      expect(result.checks).toEqual([
        { label: 'install', command: 'yarn install --immutable' },
        { label: 'test', command: 'yarn run test' },
      ])
    })

    it('uses Yarn 1’s flag when there is no berry marker', () => {
      // `--immutable` does not exist in Yarn 1 — suggesting it produces a check that fails on
      // its very first run for a reason no agent can fix.
      const result = detect({
        'package.json': pkg({ scripts: { test: 'jest' } }),
        'yarn.lock': null,
      })
      expect(result.checks[0]).toEqual({
        label: 'install',
        command: 'yarn install --frozen-lockfile',
      })
    })

    it('degrades to a plain install when no lockfile backs it', () => {
      const result = detect({ 'package.json': pkg({ scripts: { test: 'node --test' } }) })
      expect(result.checks[0]).toEqual({ label: 'install', command: 'npm install' })
    })

    it('prefers a run-once test script over a watch-mode one', () => {
      // A bare `vitest`/`jest --watch` never exits; the per-command watchdog would kill the
      // run 15 minutes later with a timeout that tells the operator nothing.
      const result = detect({
        'package.json': pkg({ scripts: { test: 'vitest', 'test:run': 'vitest run' } }),
        'package-lock.json': null,
      })
      expect(result.checks).toContainEqual({ label: 'test', command: 'npm run test:run' })
      expect(result.checks.map((c) => c.command)).not.toContain('npm run test')
    })

    it('skips npm init’s placeholder test script', () => {
      const result = detect({
        'package.json': pkg({
          scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' },
        }),
      })
      expect(result.checks.map((c) => c.label)).toEqual(['install', 'lint'])
    })

    it('drops the ecosystem when the manifest declares nothing to verify', () => {
      // An install on its own verifies nothing, so suggesting it would cost every run an
      // install for no signal — and it must not suppress the task-runner fallback either.
      expect(detect({ 'package.json': pkg({ dependencies: { left_pad: '^1' } }) }).checks).toEqual(
        [],
      )
    })

    it('falls back to presence-only rules on an unparseable manifest', () => {
      expect(detect({ 'package.json': '{ not json' }).ecosystems).toEqual([])
    })
  })

  describe('python', () => {
    it('runs the tools the pyproject configures, through the resolved toolchain', () => {
      const result = detect({
        'pyproject.toml': [
          '[tool.uv]',
          '[tool.ruff]',
          '[tool.mypy]',
          '[tool.pytest.ini_options]',
        ].join('\n'),
        'uv.lock': null,
      })
      expect(result.ecosystems).toEqual(['python'])
      expect(result.checks).toEqual([
        { label: 'install', command: 'uv sync --frozen' },
        { label: 'format', command: 'uv run ruff format --check .' },
        { label: 'lint', command: 'uv run ruff check .' },
        { label: 'typecheck', command: 'uv run mypy .' },
        { label: 'test', command: 'uv run pytest' },
      ])
    })

    it('suggests no lint gate when no linter is configured', () => {
      const result = detect({ 'requirements.txt': null, 'tests/': null })
      expect(result.checks).toEqual([
        { label: 'install', command: 'pip install -r requirements.txt' },
        { label: 'test', command: 'pytest' },
      ])
    })

    it('lets tox own the suite instead of suggesting pytest beside it', () => {
      const result = detect({ 'tox.ini': null, 'tests/': null, 'requirements.txt': null })
      expect(result.checks.map((c) => c.command)).toEqual([
        'pip install -r requirements.txt',
        'tox',
      ])
    })
  })

  describe('go and rust', () => {
    it('suggests go’s canonical commands, and golangci-lint only when configured', () => {
      expect(detect({ 'go.mod': null }).checks).toEqual([
        { label: 'lint', command: 'go vet ./...' },
        { label: 'build', command: 'go build ./...' },
        { label: 'test', command: 'go test ./...' },
      ])
      expect(detect({ 'go.mod': null, '.golangci.yml': null }).checks[0]).toEqual({
        label: 'lint',
        command: 'golangci-lint run ./...',
      })
    })

    it('gates rust’s opinionated checks on their config files', () => {
      // A repo that never ran rustfmt/clippy fails both wholesale on the first attempt.
      expect(detect({ 'Cargo.toml': null }).checks).toEqual([
        { label: 'test', command: 'cargo test' },
      ])
      const configured = detect({
        'Cargo.toml': null,
        'Cargo.lock': null,
        'rustfmt.toml': null,
        'clippy.toml': null,
      })
      expect(configured.checks.map((c) => c.label)).toEqual(['format', 'lint', 'test'])
      expect(configured.checks.at(-1)?.command).toBe('cargo test --locked')
    })
  })

  describe('other ecosystems', () => {
    it('prefers a JVM wrapper over the ambient tool', () => {
      expect(detect({ 'pom.xml': null, mvnw: null }).checks).toEqual([
        { label: 'verify', command: './mvnw -B --no-transfer-progress verify' },
      ])
      expect(detect({ 'build.gradle.kts': null }).checks).toEqual([
        { label: 'build', command: 'gradle --no-daemon build' },
      ])
    })

    it('detects dotnet from a project file suffix', () => {
      expect(detect({ 'Api.csproj': null }).checks).toEqual([
        { label: 'restore', command: 'dotnet restore' },
        { label: 'test', command: 'dotnet test --nologo' },
      ])
    })

    it('picks ruby’s runner from what the repo checked in', () => {
      expect(detect({ Gemfile: null, '.rubocop.yml': null, 'spec/': null }).checks).toEqual([
        { label: 'install', command: 'bundle install' },
        { label: 'lint', command: 'bundle exec rubocop' },
        { label: 'test', command: 'bundle exec rspec' },
      ])
    })

    it('uses composer scripts, falling back to a phpunit config', () => {
      expect(
        detect({
          'composer.json': pkg({ scripts: { phpstan: 'phpstan analyse' } }),
          'phpunit.xml': null,
        }).checks,
      ).toEqual([
        { label: 'install', command: 'composer install --no-interaction --prefer-dist' },
        { label: 'static analysis', command: 'composer run-script phpstan' },
        { label: 'test', command: 'vendor/bin/phpunit' },
      ])
    })

    it('detects elixir, gating the formatter on .formatter.exs', () => {
      expect(detect({ 'mix.exs': null }).checks).toEqual([
        { label: 'deps', command: 'mix deps.get' },
        { label: 'test', command: 'mix test' },
      ])
      expect(detect({ 'mix.exs': null, '.formatter.exs': null }).checks[1]).toEqual({
        label: 'format',
        command: 'mix format --check-formatted',
      })
    })
  })

  describe('task runners', () => {
    it('reads Make targets when no language ecosystem matched', () => {
      const result = detect({
        Makefile: ['.PHONY: lint test', 'lint:', '\tgolint', 'test:', '\tgotest', 'VAR := x'].join(
          '\n',
        ),
      })
      expect(result.ecosystems).toEqual(['make'])
      expect(result.checks).toEqual([
        { label: 'lint', command: 'make lint' },
        { label: 'test', command: 'make test' },
      ])
    })

    it('treats an umbrella target as the single check', () => {
      // A repo that declares `make ci` means it to run everything; suggesting the individual
      // targets beside it would run each of them twice.
      const result = detect({ Makefile: 'ci:\n\tmake lint test\nlint:\n\techo\ntest:\n\techo\n' })
      expect(result.checks).toEqual([{ label: 'ci', command: 'make ci' }])
    })

    it('does not suggest a task runner beside a language ecosystem', () => {
      // `make test` would almost always shell out to `go test ./...`, so suggesting both runs
      // the same suite twice on every single run.
      const result = detect({ 'go.mod': null, Makefile: 'test:\n\tgo test ./...\n' })
      expect(result.ecosystems).toEqual(['go'])
    })

    it('reads just recipes and Taskfile tasks', () => {
      expect(
        detect({ justfile: 'lint:\n  oxlint .\ntest arg="":\n  vitest run\n' }).checks,
      ).toEqual([
        { label: 'lint', command: 'just lint' },
        { label: 'test', command: 'just test' },
      ])
      // Parsed as YAML, so a task body's own keys (`cmds`, `deps`) are never read as tasks.
      const taskfile = [
        "version: '3'",
        'tasks:',
        '  test:',
        '    cmds:',
        '      - go test ./...',
      ].join('\n')
      expect(detect({ 'Taskfile.yml': taskfile }).checks).toEqual([
        { label: 'test', command: 'task test' },
      ])
    })
  })

  describe('composition', () => {
    it('suggests every language ecosystem in a polyglot repo, grouped and role-ordered', () => {
      const result = detect({
        'package.json': pkg({ scripts: { lint: 'eslint .', test: 'vitest run' } }),
        'package-lock.json': null,
        'go.mod': null,
      })
      expect(result.ecosystems).toEqual(['node', 'go'])
      expect(result.checks.map((c) => c.command)).toEqual([
        'npm ci',
        'npm run lint',
        'npm run test',
        'go vet ./...',
        'go build ./...',
        'go test ./...',
      ])
    })

    it('disambiguates labels two ecosystems both claim', () => {
      // The write contract REJECTS duplicate labels, so a suggestion carrying two `test`
      // rows could not be saved — with an error naming neither of them.
      const result = detect({
        'package.json': pkg({ scripts: { test: 'vitest run' } }),
        'go.mod': null,
      })
      expect(result.checks.map((c) => c.label)).toEqual([
        'install',
        'test',
        'lint',
        'build',
        'test (go)',
      ])
    })

    it('reports truncation rather than silently dropping suggestions', () => {
      const result = detect({
        'package.json': pkg({
          scripts: {
            'format:check': 'prettier -c .',
            lint: 'eslint .',
            typecheck: 'tsc --noEmit',
            build: 'tsc -b',
            'test:run': 'vitest run',
          },
        }),
        'package-lock.json': null,
        'go.mod': null,
        'mix.exs': null,
        '.formatter.exs': null,
      })
      expect(result.truncated).toBe(true)
      // Node (6) + Go (3) fill the budget; Elixir's remaining slot would have held only
      // `mix deps.get`, which verifies nothing — so the whole group goes rather than leaving
      // an install behind that costs every run time and reads as coverage.
      expect(result.checks).toHaveLength(9)
      expect(result.checks.map((c) => c.command)).not.toContain('mix deps.get')
      expect(result.ecosystems).not.toContain('elixir')
    })
  })

  describe('dependencyInstall', () => {
    it('suggests the install of an ecosystem that contributes no checks at all', () => {
      // The whole point of prepopulation: a repo with dependencies to install and nothing
      // declared to verify. It contributes no CHECK (an install verifies nothing), yet it is
      // exactly the repo whose agent would otherwise read a manifest instead of the packages.
      const result = detect({
        'package.json': pkg({ dependencies: { zod: '^3' } }),
        'pnpm-lock.yaml': null,
      })
      expect(result.checks).toEqual([])
      expect(result.ecosystems).toEqual([])
      expect(result.truncated).toBe(false)
      expect(result.dependencyInstall).toBe('pnpm install --frozen-lockfile')
    })

    it('still falls back to the task runner when the only language hit is install-only', () => {
      // An install-only language detection no longer nulls out inside `ecosystem()`, so the
      // fallback has to key off whether anything VERIFIES — not merely whether a language
      // ecosystem was detected — or a Makefile-driven repo would silently lose its checks.
      const result = detect({
        'package.json': pkg({ dependencies: { zod: '^3' } }),
        Makefile: 'test:\n\tgo test ./...\n',
      })
      expect(result.ecosystems).toEqual(['make'])
      expect(result.checks).toEqual([{ label: 'test', command: 'make test' }])
      expect(result.dependencyInstall).toBe('npm install')
    })

    it('chains every detected ecosystem’s install, deduplicated', () => {
      const result = detect({
        'package.json': pkg({ scripts: { test: 'vitest run' } }),
        'package-lock.json': null,
        Gemfile: null,
        Rakefile: null,
      })
      expect(result.dependencyInstall).toBe('npm ci && bundle install')
    })

    it('is absent when nothing detected declares an install', () => {
      const result = detect({ 'go.mod': null })
      expect(result.checks.length).toBeGreaterThan(0)
      expect(result.dependencyInstall).toBeUndefined()
    })
  })
})
