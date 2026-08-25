// How each SDK's smoketest program is invoked.
//
// One entry per language, each responsible only for turning "here is a deployment and two keys"
// into "here is this SDK's observation report". Keeping the four invocations in one table is what
// lets `run.ts` treat them uniformly — and makes it obvious when a language's toolchain is absent
// rather than its SDK being broken, which are very different failures.

import { spawn } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'
import { delimiter as classpathSeparator, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SdkReport } from './parity.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const sdkRoot = resolve(repoRoot, 'sdk')

export interface RunnerContext {
  baseUrl: string
  adminKey: string
  readKey: string
  /** A base URL with nothing listening on it, for the connection-failure case. */
  deadUrl: string
  /** Where this SDK writes its report. */
  outPath: string
}

export interface SdkRunner {
  /** The SDK's name — must match the `sdk` field its program writes. */
  name: string
  /** The command + args to run, and the directory to run them in. */
  command(context: RunnerContext): {
    cmd: string
    args: string[]
    cwd: string
    env?: NodeJS.ProcessEnv
  }
  /** A command that proves the language's toolchain is present. */
  toolcheck: { cmd: string; args: string[] }
  /** Optional build step run before the smoketest (compilation, dependency resolution). */
  prepare?(): Promise<void>
}

export const RUNNERS: SdkRunner[] = [
  {
    name: 'typescript',
    toolcheck: { cmd: process.execPath, args: ['--version'] },
    command: () => ({
      cmd: process.execPath,
      args: ['--experimental-strip-types', 'smoketest/main.ts'],
      cwd: resolve(sdkRoot, 'typescript'),
    }),
  },
  {
    name: 'python',
    toolcheck: { cmd: 'python3', args: ['--version'] },
    command: () => ({
      cmd: 'python3',
      args: ['smoketest/main.py'],
      cwd: resolve(sdkRoot, 'python'),
    }),
  },
  {
    name: 'go',
    toolcheck: { cmd: 'go', args: ['version'] },
    command: () => ({
      cmd: 'go',
      args: ['run', './smoketest'],
      cwd: resolve(sdkRoot, 'go'),
    }),
  },
  {
    name: 'java',
    toolcheck: { cmd: 'mvn', args: ['-v'] },
    // The Java program lives outside `src/main` and `src/test` (it is neither published nor a
    // unit test), so it is compiled explicitly against the built classes plus the resolved
    // dependency classpath. `mvn dependency:build-classpath` writes that classpath to a file —
    // no extra plugin, and it reuses whatever Maven has already cached.
    async prepare() {
      const javaRoot = resolve(sdkRoot, 'java')
      await run('mvn', ['-B', '-q', 'compile'], javaRoot)
      await run(
        'mvn',
        ['-B', '-q', 'dependency:build-classpath', '-Dmdep.outputFile=target/classpath.txt'],
        javaRoot,
      )
      const classpath = (await readFile(resolve(javaRoot, 'target/classpath.txt'), 'utf8')).trim()
      await mkdir(resolve(javaRoot, 'target/smoketest-classes'), { recursive: true })
      await run(
        'javac',
        [
          '-cp',
          [resolve(javaRoot, 'target/classes'), classpath].join(classpathSeparator),
          '-d',
          resolve(javaRoot, 'target/smoketest-classes'),
          resolve(javaRoot, 'smoketest/java/ai/catfactory/sdk/smoketest/Smoketest.java'),
        ],
        javaRoot,
      )
    },
    command: () => {
      const javaRoot = resolve(sdkRoot, 'java')
      return {
        cmd: 'java',
        args: [
          '-cp',
          [
            resolve(javaRoot, 'target/classes'),
            resolve(javaRoot, 'target/smoketest-classes'),
            '@CLASSPATH@',
          ].join(classpathSeparator),
          'ai.catfactory.sdk.smoketest.Smoketest',
        ],
        cwd: javaRoot,
      }
    },
  },
]

/** Whether the language's toolchain is available on this machine. */
export async function toolchainAvailable(runner: SdkRunner): Promise<boolean> {
  try {
    await run(runner.toolcheck.cmd, runner.toolcheck.args, repoRoot)
    return true
  } catch {
    return false
  }
}

/** Run one SDK's smoketest and read back its report. */
export async function runSdk(runner: SdkRunner, context: RunnerContext): Promise<SdkReport> {
  await runner.prepare?.()
  const spec = runner.command(context)
  const args = await resolveArgs(spec.args)
  await run(spec.cmd, args, spec.cwd, {
    ...process.env,
    ...spec.env,
    CAT_FACTORY_BASE_URL: context.baseUrl,
    CAT_FACTORY_API_KEY: context.adminKey,
    CAT_FACTORY_READ_KEY: context.readKey,
    CAT_FACTORY_SMOKETEST_DEAD_URL: context.deadUrl,
    CAT_FACTORY_SMOKETEST_OUT: context.outPath,
  })
  const report = JSON.parse(await readFile(context.outPath, 'utf8')) as SdkReport
  if (report.sdk !== runner.name) {
    throw new Error(
      `sdk-smoketest: the ${runner.name} program wrote a report labelled '${report.sdk}'`,
    )
  }
  return report
}

/**
 * Substitute the Java classpath placeholder.
 *
 * The classpath is only known after `prepare()` has resolved it, and it is far too long to thread
 * through the runner table as data — so the table names a placeholder and it is filled in here,
 * once, right before the process is spawned.
 */
async function resolveArgs(args: string[]): Promise<string[]> {
  if (!args.some((arg) => arg.includes('@CLASSPATH@'))) return args
  const classpath = (await readFile(resolve(sdkRoot, 'java/target/classpath.txt'), 'utf8')).trim()
  return args.map((arg) => arg.replace('@CLASSPATH@', classpath))
}

/** Spawn a process, streaming its output, and reject on a non-zero exit. */
function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveRun()
      else reject(new Error(`${cmd} ${args.slice(0, 2).join(' ')} exited with ${code}`))
    })
  })
}
