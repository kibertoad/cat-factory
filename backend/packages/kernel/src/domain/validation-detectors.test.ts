import { describe, expect, it } from 'vitest'
import { RepoView, type EcosystemDetection, type RepoSurface } from './validation-detection.js'
import {
  DEFAULT_VALIDATION_DETECTORS,
  LANGUAGE_DETECTORS,
  TASK_RUNNER_DETECTORS,
  VALIDATION_DETECTION_CONTENT_FILES,
  detectDotnet,
  detectElixir,
  detectGo,
  detectGradle,
  detectJust,
  detectMake,
  detectMaven,
  detectNode,
  detectPhp,
  detectPython,
  detectRuby,
  detectRust,
  detectTask,
} from './validation-detectors.js'

/**
 * A repo view from a `{ name: content }` map: `null` is a file the reader listed but did not
 * fetch (presence-only) and a trailing `/` is a directory. Mirrors the surface builder in
 * `validation-detection.test.ts`; these tests drive each detector DIRECTLY, where that one
 * drives the composed `detectValidationChecks`.
 */
function view(entries: Record<string, string | null>): RepoView {
  const files: Record<string, string> = {}
  const list = Object.entries(entries).map(([name, content]) => {
    if (content !== null && !name.endsWith('/')) files[name] = content
    return name.endsWith('/')
      ? { name: name.slice(0, -1), type: 'dir' as const }
      : { name, type: 'file' as const }
  })
  return new RepoView({ entries: list, files } satisfies RepoSurface)
}

const pkg = (manifest: Record<string, unknown>) => JSON.stringify(manifest)

/** The `{ role: command }` map a detection produced, for readable per-role assertions. */
function commands(detection: EcosystemDetection | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of detection?.checks ?? []) out[c.role] = c.command
  return out
}

const labels = (detection: EcosystemDetection | null) =>
  (detection?.checks ?? []).map((c) => c.label)

describe('detectNode', () => {
  it('is absent without a package.json, even when a lockfile is there', () => {
    expect(detectNode(view({ 'pnpm-lock.yaml': null }))).toBeNull()
  })

  it('drops the ecosystem when the manifest declares no script to verify with', () => {
    // An install alone verifies nothing, and `ecosystem()` keeps only non-empty check lists,
    // so a manifest with no scripts must not produce a node ecosystem at all.
    expect(
      detectNode(view({ 'package.json': pkg({ name: 'x' }) }))?.checks.map((c) => c.role),
    ).toEqual(['install'])
  })

  describe('the package manager', () => {
    const install = (entries: Record<string, string | null>) =>
      commands(detectNode(view({ 'package.json': pkg({}), ...entries }))).install

    it('prefers the declared packageManager over any lockfile, version suffix and all', () => {
      expect(
        install({
          'package.json': pkg({ packageManager: 'pnpm@10.0.0' }),
          'package-lock.json': null,
        }),
      ).toBe('pnpm install')
      expect(
        install({ 'package.json': pkg({ packageManager: '  YARN@1.22.0  ' }), 'yarn.lock': null }),
      ).toBe('yarn install --frozen-lockfile')
    })

    it('ignores a non-string packageManager and falls back to the lockfile', () => {
      expect(install({ 'package.json': pkg({ packageManager: 42 }), 'pnpm-lock.yaml': null })).toBe(
        'pnpm install --frozen-lockfile',
      )
    })

    it('asks for a reproducible install per manager when a lockfile backs it', () => {
      expect(install({ 'pnpm-lock.yaml': null })).toBe('pnpm install --frozen-lockfile')
      expect(install({ 'yarn.lock': null })).toBe('yarn install --frozen-lockfile')
      expect(install({ 'bun.lockb': null })).toBe('bun install --frozen-lockfile')
      expect(install({ 'bun.lock': null })).toBe('bun install --frozen-lockfile')
      expect(install({ 'package-lock.json': null })).toBe('npm ci')
    })

    it('degrades to a plain install when the declared manager has no lockfile', () => {
      expect(install({ 'package.json': pkg({ packageManager: 'pnpm@10' }) })).toBe('pnpm install')
      expect(install({ 'package.json': pkg({ packageManager: 'yarn@4' }) })).toBe('yarn install')
      expect(install({ 'package.json': pkg({ packageManager: 'bun@1' }) })).toBe('bun install')
      expect(install({})).toBe('npm install')
    })

    it('spells Yarn 1 and Yarn berry’s immutable flag differently', () => {
      // Yarn 1 errors on `--immutable`, and berry errors on `--frozen-lockfile`, so picking the
      // wrong one is a check that fails on its first run for a reason no agent can fix.
      expect(install({ 'yarn.lock': null })).toBe('yarn install --frozen-lockfile')
      expect(install({ 'yarn.lock': null, '.yarnrc.yml': null })).toBe('yarn install --immutable')
      expect(
        install({ 'package.json': pkg({ packageManager: 'yarn@3.6.0' }), 'yarn.lock': null }),
      ).toBe('yarn install --immutable')
      // A `yarn@1.x` declaration is NOT berry, even though it names a version.
      expect(
        install({ 'package.json': pkg({ packageManager: 'yarn@1.22.19' }), 'yarn.lock': null }),
      ).toBe('yarn install --frozen-lockfile')
    })

    it('runs scripts through the resolved manager', () => {
      const runner = (entries: Record<string, string | null>) =>
        commands(detectNode(view({ ...entries, 'package.json': pkg({ scripts: { lint: 'x' } }) })))
          .lint
      expect(runner({ 'pnpm-lock.yaml': null })).toBe('pnpm run lint')
      expect(runner({ 'yarn.lock': null })).toBe('yarn run lint')
      expect(runner({ 'bun.lock': null })).toBe('bun run lint')
      expect(runner({})).toBe('npm run lint')
    })
  })

  describe('the script roles', () => {
    const rolesFor = (scripts: Record<string, unknown>) =>
      commands(detectNode(view({ 'package.json': pkg({ scripts }) })))

    it('takes the most specific declared name per role', () => {
      expect(
        rolesFor({
          'format:check': 'prettier -c .',
          format: 'prettier -w .',
          'lint:ci': 'eslint .',
          lint: 'eslint --fix .',
          'type-check': 'tsc --noEmit',
          typecheck: 'tsc -b',
          compile: 'tsc -b',
          build: 'vite build',
          test: 'vitest',
          'test:ci': 'vitest run',
        }),
      ).toMatchObject({
        format: 'npm run format:check',
        lint: 'npm run lint',
        typecheck: 'npm run typecheck',
        build: 'npm run build',
        test: 'npm run test:ci',
      })
    })

    it('falls through to a later alias when the preferred name is absent', () => {
      expect(rolesFor({ 'prettier:check': 'prettier -c .' }).format).toBe('npm run prettier:check')
      expect(rolesFor({ 'biome:check': 'biome check' }).lint).toBe('npm run biome:check')
      expect(rolesFor({ types: 'tsc --noEmit' }).typecheck).toBe('npm run types')
      expect(rolesFor({ compile: 'tsc -b' }).build).toBe('npm run compile')
      expect(rolesFor({ tests: 'vitest run' }).test).toBe('npm run tests')
    })

    it('skips npm init’s placeholder and keeps looking down the list', () => {
      expect(
        rolesFor({
          test: 'echo "Error: no test specified" && exit 1',
          'test:unit': 'vitest run',
        }).test,
      ).toBe('npm run test:unit')
      expect(rolesFor({ test: 'echo "Error: no test specified" && exit 1' }).test).toBeUndefined()
    })

    it('ignores a non-string script body and a non-object scripts field', () => {
      expect(rolesFor({ lint: ['eslint', '.'] }).lint).toBeUndefined()
      expect(rolesFor({ lint: null }).lint).toBeUndefined()
      expect(
        commands(detectNode(view({ 'package.json': pkg({ scripts: 'lint' }) }))).lint,
      ).toBeUndefined()
      expect(
        commands(detectNode(view({ 'package.json': pkg({ scripts: ['lint'] }) }))).lint,
      ).toBeUndefined()
      expect(
        commands(detectNode(view({ 'package.json': pkg({ scripts: null }) }))).lint,
      ).toBeUndefined()
    })

    it('degrades to presence-only rules on an unparseable manifest', () => {
      expect(commands(detectNode(view({ 'package.json': '{ not json' })))).toEqual({
        install: 'npm install',
      })
    })
  })
})

describe('detectPython', () => {
  it('is absent without any python marker', () => {
    expect(detectPython(view({ 'main.py': null }))).toBeNull()
  })

  it('is triggered by every marker file the ecosystem is recognised from', () => {
    // Each marker gets past the guard; `conftest.py` supplies the one check every case needs so
    // the assertion is about RECOGNITION rather than about what each marker happens to imply.
    for (const marker of [
      'pyproject.toml',
      'requirements.txt',
      'setup.py',
      'setup.cfg',
      'tox.ini',
      'Pipfile',
    ]) {
      const detection = detectPython(view({ [marker]: '', 'conftest.py': null }))
      expect(detection?.ecosystem, marker).toBe('python')
    }
  })

  it('yields nothing for a marker that evidences neither a dependency source nor a check', () => {
    // `setup.cfg` alone names no dependency manager and no tool, so python is RECOGNISED and
    // still contributes nothing, which `ecosystem()` collapses to no detection at all.
    expect(detectPython(view({ 'setup.cfg': null }))).toBeNull()
  })

  describe('the toolchain', () => {
    const toolchain = (entries: Record<string, string | null>) =>
      commands(detectPython(view(entries)))

    it('resolves uv, poetry and pdm from their lockfile OR their pyproject section', () => {
      expect(toolchain({ 'pyproject.toml': '', 'uv.lock': null }).install).toBe('uv sync --frozen')
      expect(toolchain({ 'pyproject.toml': '[tool.uv]\n' }).install).toBe('uv sync')
      expect(toolchain({ 'pyproject.toml': '', 'poetry.lock': null }).install).toBe(
        'poetry install --no-interaction',
      )
      expect(toolchain({ 'pyproject.toml': '[tool.poetry]\n' }).install).toBe(
        'poetry install --no-interaction',
      )
      expect(toolchain({ 'pyproject.toml': '', 'pdm.lock': null }).install).toBe('pdm install')
      expect(toolchain({ 'pyproject.toml': '[tool.pdm]\n' }).install).toBe('pdm install')
    })

    it('falls back through pipenv, requirements and a bare project', () => {
      expect(toolchain({ Pipfile: null }).install).toBe('pipenv install --dev')
      expect(toolchain({ 'requirements.txt': null }).install).toBe(
        'pip install -r requirements.txt',
      )
      expect(toolchain({ 'pyproject.toml': '' }).install).toBe('pip install -e .')
      expect(toolchain({ 'setup.py': null }).install).toBe('pip install -e .')
    })

    it('suggests no install for a marker that names no dependency source', () => {
      expect(toolchain({ 'setup.cfg': null, 'conftest.py': null }).install).toBeUndefined()
      expect(toolchain({ 'setup.cfg': null, 'conftest.py': null }).test).toBe('pytest')
    })

    it('prefixes every tool with the project env runner', () => {
      const uv = toolchain({
        'pyproject.toml': '[tool.uv]\n[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n',
      })
      expect(uv).toMatchObject({
        format: 'uv run ruff format --check .',
        lint: 'uv run ruff check .',
        typecheck: 'uv run mypy .',
        test: 'uv run pytest',
      })
    })
  })

  describe('the tool gates', () => {
    const tools = (entries: Record<string, string | null>) =>
      commands(detectPython(view({ 'requirements.txt': null, ...entries })))

    it('prefers ruff over black for the format gate, and needs one of them', () => {
      expect(tools({ 'pyproject.toml': '[tool.ruff]\n[tool.black]\n' }).format).toBe(
        'ruff format --check .',
      )
      expect(tools({ 'pyproject.toml': '[tool.black]\n' }).format).toBe('black --check .')
      expect(tools({ 'pyproject.toml': '' }).format).toBeUndefined()
    })

    it('reads ruff from a standalone config too, and only ruff lints', () => {
      expect(tools({ 'ruff.toml': null }).lint).toBe('ruff check .')
      expect(tools({ '.ruff.toml': null }).lint).toBe('ruff check .')
      expect(tools({ 'pyproject.toml': '[tool.black]\n' }).lint).toBeUndefined()
    })

    it('prefers mypy over pyright, from a section or a standalone config', () => {
      expect(tools({ 'pyproject.toml': '[tool.mypy]\n[tool.pyright]\n' }).typecheck).toBe('mypy .')
      expect(tools({ 'mypy.ini': null }).typecheck).toBe('mypy .')
      expect(tools({ '.mypy.ini': null }).typecheck).toBe('mypy .')
      expect(tools({ 'pyproject.toml': '[tool.pyright]\n' }).typecheck).toBe('pyright')
      expect(tools({ 'pyrightconfig.json': null }).typecheck).toBe('pyright')
      expect(tools({}).typecheck).toBeUndefined()
    })
  })

  describe('the test runner', () => {
    const test = (entries: Record<string, string | null>) =>
      commands(detectPython(view({ 'requirements.txt': null, ...entries }))).test

    it('lets tox own the suite instead of running it twice', () => {
      expect(test({ 'tox.ini': null, 'conftest.py': null, 'tests/': null })).toBe('tox')
    })

    it('accepts any of pytest’s four signals', () => {
      expect(test({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })).toBe('pytest')
      expect(test({ 'pytest.ini': null })).toBe('pytest')
      expect(test({ 'conftest.py': null })).toBe('pytest')
      expect(test({ 'tests/': null })).toBe('pytest')
      expect(test({ 'test/': null })).toBe('pytest')
    })

    it('needs a DIRECTORY named tests, not a file called tests', () => {
      expect(test({ tests: null })).toBeUndefined()
    })

    it('suggests nothing when no runner is evidenced', () => {
      expect(test({})).toBeUndefined()
    })
  })
})

describe('hasTomlSection (through the python detector)', () => {
  const hasRuff = (pyproject: string) =>
    commands(detectPython(view({ 'pyproject.toml': pyproject }))).lint !== undefined

  it('matches a bare section and any sub-table beneath it', () => {
    expect(hasRuff('[tool.ruff]\n')).toBe(true)
    expect(hasRuff('[tool.ruff.lint]\n')).toBe(true)
    expect(hasRuff('  [ tool.ruff ]\n')).toBe(true)
    expect(hasRuff('[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n')).toBe(true)
  })

  it('does not match a different section, or the name inside a longer one', () => {
    expect(hasRuff('[tool.black]\n')).toBe(false)
    expect(hasRuff('[tool.ruffian]\n')).toBe(false)
    expect(hasRuff('[tool]\nruff = 1\n')).toBe(false)
  })

  it('treats the dots as literals rather than as regex wildcards', () => {
    expect(hasRuff('[toolXruff]\n')).toBe(false)
  })

  it('is false for a manifest whose content was never fetched', () => {
    expect(commands(detectPython(view({ 'pyproject.toml': null }))).lint).toBeUndefined()
  })
})

describe('detectGo', () => {
  it('is absent without a go.mod', () => {
    expect(detectGo(view({ 'main.go': null }))).toBeNull()
  })

  it('suggests the toolchain’s own commands unconditionally', () => {
    expect(commands(detectGo(view({ 'go.mod': null })))).toEqual({
      lint: 'go vet ./...',
      build: 'go build ./...',
      test: 'go test ./...',
    })
  })

  it('upgrades the lint gate only when golangci-lint’s config is checked in', () => {
    for (const cfg of ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json']) {
      expect(commands(detectGo(view({ 'go.mod': null, [cfg]: null }))).lint, cfg).toBe(
        'golangci-lint run ./...',
      )
    }
    expect(commands(detectGo(view({ 'go.mod': null, 'golangci.yml': null }))).lint).toBe(
      'go vet ./...',
    )
  })
})

describe('detectRust', () => {
  it('is absent without a Cargo.toml', () => {
    expect(detectRust(view({ 'Cargo.lock': null }))).toBeNull()
  })

  it('gates the opinionated checks on the repo’s own config', () => {
    expect(commands(detectRust(view({ 'Cargo.toml': null })))).toEqual({ test: 'cargo test' })
    for (const cfg of ['rustfmt.toml', '.rustfmt.toml']) {
      expect(commands(detectRust(view({ 'Cargo.toml': null, [cfg]: null }))).format, cfg).toBe(
        'cargo fmt --all -- --check',
      )
    }
    for (const cfg of ['clippy.toml', '.clippy.toml']) {
      expect(commands(detectRust(view({ 'Cargo.toml': null, [cfg]: null }))).lint, cfg).toBe(
        'cargo clippy --all-targets -- -D warnings',
      )
    }
  })

  it('locks the test run to the checked-in lockfile when there is one', () => {
    expect(commands(detectRust(view({ 'Cargo.toml': null, 'Cargo.lock': null }))).test).toBe(
      'cargo test --locked',
    )
  })
})

describe('detectMaven and detectGradle', () => {
  it('are absent without their build files', () => {
    expect(detectMaven(view({ 'build.gradle': null }))).toBeNull()
    expect(detectGradle(view({ 'pom.xml': null }))).toBeNull()
  })

  it('prefer the checked-in wrapper over the ambient tool', () => {
    expect(commands(detectMaven(view({ 'pom.xml': null }))).test).toBe(
      'mvn -B --no-transfer-progress verify',
    )
    expect(commands(detectMaven(view({ 'pom.xml': null, mvnw: null }))).test).toBe(
      './mvnw -B --no-transfer-progress verify',
    )
    expect(commands(detectGradle(view({ 'build.gradle': null }))).build).toBe(
      'gradle --no-daemon build',
    )
    expect(commands(detectGradle(view({ 'build.gradle': null, gradlew: null }))).build).toBe(
      './gradlew --no-daemon build',
    )
  })

  it('recognise gradle from any of its four build/settings files', () => {
    for (const f of [
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
    ]) {
      expect(detectGradle(view({ [f]: null })), f).not.toBeNull()
    }
  })

  it('label the single command by the lifecycle phase it runs', () => {
    expect(labels(detectMaven(view({ 'pom.xml': null })))).toEqual(['verify'])
    expect(labels(detectGradle(view({ 'build.gradle': null })))).toEqual(['build'])
  })
})

describe('detectDotnet', () => {
  it('is absent without a project file', () => {
    expect(detectDotnet(view({ 'Program.cs': null }))).toBeNull()
  })

  it('recognises every project/solution suffix, anywhere in the name', () => {
    for (const suffix of ['.sln', '.slnx', '.csproj', '.fsproj', '.vbproj']) {
      expect(detectDotnet(view({ [`App${suffix}`]: null })), suffix).not.toBeNull()
    }
  })

  it('lets `dotnet test` do the build rather than compiling twice', () => {
    expect(commands(detectDotnet(view({ 'App.csproj': null })))).toEqual({
      install: 'dotnet restore',
      test: 'dotnet test --nologo',
    })
  })
})

describe('detectRuby', () => {
  it('is absent without a Gemfile', () => {
    expect(detectRuby(view({ Rakefile: null, 'spec/': null }))).toBeNull()
  })

  it('always installs, and lints only with a rubocop config', () => {
    expect(commands(detectRuby(view({ Gemfile: null })))).toEqual({ install: 'bundle install' })
    for (const cfg of ['.rubocop.yml', '.rubocop.yaml']) {
      expect(commands(detectRuby(view({ Gemfile: null, [cfg]: null }))).lint, cfg).toBe(
        'bundle exec rubocop',
      )
    }
  })

  it('prefers rspec, and falls back to rake only when a Rakefile AND a test dir are there', () => {
    expect(commands(detectRuby(view({ Gemfile: null, '.rspec': null }))).test).toBe(
      'bundle exec rspec',
    )
    expect(commands(detectRuby(view({ Gemfile: null, 'spec/': null }))).test).toBe(
      'bundle exec rspec',
    )
    expect(commands(detectRuby(view({ Gemfile: null, Rakefile: null, 'test/': null }))).test).toBe(
      'bundle exec rake test',
    )
    expect(commands(detectRuby(view({ Gemfile: null, Rakefile: null }))).test).toBeUndefined()
    expect(commands(detectRuby(view({ Gemfile: null, 'test/': null }))).test).toBeUndefined()
    expect(
      commands(detectRuby(view({ Gemfile: null, 'spec/': null, Rakefile: null, 'test/': null })))
        .test,
    ).toBe('bundle exec rspec')
  })
})

describe('detectPhp', () => {
  it('is absent without a composer.json', () => {
    expect(detectPhp(view({ 'phpunit.xml': null }))).toBeNull()
  })

  it('runs the composer scripts it declares, most specific name first', () => {
    expect(
      commands(
        detectPhp(
          view({
            'composer.json': pkg({
              scripts: {
                cs: 'phpcs',
                lint: 'php -l',
                analyse: 'phpstan',
                phpstan: 'phpstan',
                tests: 'x',
                test: 'phpunit',
              },
            }),
          }),
        ),
      ),
    ).toMatchObject({
      install: 'composer install --no-interaction --prefer-dist',
      lint: 'composer run-script lint',
      typecheck: 'composer run-script phpstan',
      test: 'composer run-script test',
    })
  })

  it('labels the static-analysis role for a human rather than reusing the role name', () => {
    expect(
      labels(detectPhp(view({ 'composer.json': pkg({ scripts: { psalm: 'psalm' } }) }))),
    ).toEqual(['install', 'static analysis'])
  })

  it('falls back to the phpunit binary when a config is checked in but no script declares it', () => {
    for (const cfg of ['phpunit.xml', 'phpunit.xml.dist']) {
      expect(commands(detectPhp(view({ 'composer.json': pkg({}), [cfg]: null }))).test, cfg).toBe(
        'vendor/bin/phpunit',
      )
    }
    // A declared script still wins over the fallback.
    expect(
      commands(
        detectPhp(view({ 'composer.json': pkg({ scripts: { test: 'x' } }), 'phpunit.xml': null })),
      ).test,
    ).toBe('composer run-script test')
    expect(commands(detectPhp(view({ 'composer.json': pkg({}) }))).test).toBeUndefined()
  })
})

describe('detectElixir', () => {
  it('is absent without a mix.exs', () => {
    expect(detectElixir(view({ '.formatter.exs': null }))).toBeNull()
  })

  it('always fetches deps and tests, gating the two opinionated checks on their config', () => {
    expect(commands(detectElixir(view({ 'mix.exs': null })))).toEqual({
      install: 'mix deps.get',
      test: 'mix test',
    })
    expect(commands(detectElixir(view({ 'mix.exs': null, '.formatter.exs': null }))).format).toBe(
      'mix format --check-formatted',
    )
    expect(commands(detectElixir(view({ 'mix.exs': null, '.credo.exs': null }))).lint).toBe(
      'mix credo --strict',
    )
  })

  it('labels the install role `deps`, the name the ecosystem uses', () => {
    expect(labels(detectElixir(view({ 'mix.exs': null })))).toEqual(['deps', 'test'])
  })
})

describe('the task runners', () => {
  it('are absent when their manifest content was never fetched', () => {
    expect(detectMake(view({ Makefile: null }))).toBeNull()
    expect(detectJust(view({ justfile: null }))).toBeNull()
    expect(detectTask(view({ 'Taskfile.yml': null }))).toBeNull()
  })

  it('read the manifest under any of its accepted spellings', () => {
    for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
      expect(commands(detectMake(view({ [name]: 'test:\n\tgo test\n' }))).test, name).toBe(
        'make test',
      )
    }
    for (const name of ['justfile', 'Justfile', '.justfile']) {
      expect(commands(detectJust(view({ [name]: 'test:\n  go test\n' }))).test, name).toBe(
        'just test',
      )
    }
    for (const name of ['Taskfile.yml', 'Taskfile.yaml']) {
      expect(
        commands(detectTask(view({ [name]: 'tasks:\n  test:\n    cmds: [go test]\n' }))).test,
        name,
      ).toBe('task test')
    }
  })

  it('suggest an umbrella target ALONE, in preference order', () => {
    const make = detectMake(
      view({ Makefile: 'ci:\n\techo\ncheck:\n\techo\nlint:\n\techo\ntest:\n\techo\n' }),
    )
    expect(make?.checks).toEqual([{ role: 'test', label: 'ci', command: 'make ci' }])
    expect(
      detectMake(view({ Makefile: 'validate:\n\techo\nlint:\n\techo\n' }))?.checks.map(
        (c) => c.label,
      ),
    ).toEqual(['validate'])
  })

  it('suggest each individual target when no umbrella is declared', () => {
    expect(
      commands(
        detectMake(
          view({
            Makefile:
              'fmt:\n\techo\nlint:\n\techo\ntypecheck:\n\techo\nbuild:\n\techo\ntest:\n\techo\n',
          }),
        ),
      ),
    ).toEqual({
      format: 'make fmt',
      lint: 'make lint',
      typecheck: 'make typecheck',
      build: 'make build',
      test: 'make test',
    })
  })

  it('prefer the check-only format target over the reformatting one', () => {
    expect(
      commands(detectMake(view({ Makefile: 'fmt:\n\techo\nformat-check:\n\techo\n' }))).format,
    ).toBe('make format-check')
  })

  it('yield nothing at all when the manifest declares no recognised target', () => {
    expect(detectMake(view({ Makefile: 'deploy:\n\techo\n' }))).toBeNull()
    expect(detectMake(view({ Makefile: '' }))).toBeNull()
  })

  describe('Make target extraction', () => {
    const targets = (content: string) => commands(detectMake(view({ Makefile: content })))

    it('excludes a variable assignment, which is `:=` not `:`', () => {
      expect(targets('TEST := go test\n')).toEqual({})
      expect(targets('test := x\ntest:\n\techo\n')).toMatchObject({ test: 'make test' })
    })

    it('excludes a tab-indented recipe line and a dot-directive', () => {
      expect(targets('build:\n\ttest: not a target\n')).toEqual({ build: 'make build' })
      expect(targets('.PHONY: test\n')).toEqual({})
    })

    it('folds target names to lower case', () => {
      expect(targets('TEST:\n\techo\n')).toEqual({ test: 'make test' })
    })

    it('accepts the punctuation a make target may carry', () => {
      expect(targets('lint:\nbuild-all:\n')).toMatchObject({ lint: 'make lint' })
    })
  })

  describe('just recipe extraction', () => {
    const recipes = (content: string) => commands(detectJust(view({ justfile: content })))

    it('reads a quiet recipe and one taking parameters', () => {
      expect(recipes('@test:\n  go test\n')).toEqual({ test: 'just test' })
      expect(recipes('test target="all":\n  go test\n')).toEqual({ test: 'just test' })
    })

    it('excludes a variable assignment', () => {
      expect(recipes('test := "x"\n')).toEqual({})
    })
  })

  describe('Taskfile task extraction', () => {
    const tasks = (content: string) => commands(detectTask(view({ 'Taskfile.yml': content })))

    it('reads only the top-level task names, not their bodies', () => {
      expect(
        tasks(
          'version: "3"\ntasks:\n  test:\n    cmds:\n      - go test\n  lint:\n    deps: [test]\n',
        ),
      ).toEqual({ lint: 'task lint', test: 'task test' })
    })

    it('folds task names to lower case', () => {
      expect(tasks('tasks:\n  TEST:\n    cmds: [go test]\n')).toEqual({ test: 'task test' })
    })

    it('is a detection MISS rather than an error on unparseable YAML', () => {
      expect(detectTask(view({ 'Taskfile.yml': 'tasks:\n  - [unbalanced\n' }))).toBeNull()
    })

    it('ignores a tasks key that is not a map', () => {
      expect(detectTask(view({ 'Taskfile.yml': 'tasks:\n  - test\n' }))).toBeNull()
      expect(detectTask(view({ 'Taskfile.yml': 'tasks: test\n' }))).toBeNull()
      expect(detectTask(view({ 'Taskfile.yml': 'version: "3"\n' }))).toBeNull()
      expect(detectTask(view({ 'Taskfile.yml': '' }))).toBeNull()
    })
  })
})

describe('the detector registries', () => {
  it('separate the language ecosystems from the task-runner fallback tier', () => {
    expect(DEFAULT_VALIDATION_DETECTORS.language).toBe(LANGUAGE_DETECTORS)
    expect(DEFAULT_VALIDATION_DETECTORS.taskRunner).toBe(TASK_RUNNER_DETECTORS)
    expect(new Set(LANGUAGE_DETECTORS).size).toBe(LANGUAGE_DETECTORS.length)
    for (const detector of TASK_RUNNER_DETECTORS) {
      expect(LANGUAGE_DETECTORS).not.toContain(detector)
    }
  })

  it('recognise nothing in an empty repo, so an unknown repo suggests nothing', () => {
    for (const detector of [...LANGUAGE_DETECTORS, ...TASK_RUNNER_DETECTORS]) {
      expect(detector(view({}))).toBeNull()
    }
  })

  it('fetch the content of every manifest a detector actually READS', () => {
    // A detector reading a file the fetch list omits sees `undefined` forever: the rule silently
    // never fires, and nothing fails. Anchored the other way round too: an entry nothing reads
    // is a round trip bought on every detection for nothing.
    const contentReaders = new Set([
      'package.json',
      'composer.json',
      'pyproject.toml',
      'Makefile',
      'makefile',
      'GNUmakefile',
      'justfile',
      'Justfile',
      '.justfile',
      'Taskfile.yml',
      'Taskfile.yaml',
    ])
    expect(new Set(VALIDATION_DETECTION_CONTENT_FILES)).toEqual(contentReaders)
    expect(new Set(VALIDATION_DETECTION_CONTENT_FILES).size).toBe(
      VALIDATION_DETECTION_CONTENT_FILES.length,
    )
  })
})
