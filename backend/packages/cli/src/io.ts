import { spawn } from 'node:child_process'
import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  log,
  type Option,
  password,
  select as clackSelect,
  text,
} from '@clack/prompts'

/**
 * Terminal I/O seam. The orchestrator depends on this interface (never on `@clack/prompts` or
 * `process` directly), so the whole interactive flow can be driven by a fake in tests. The real
 * implementation ({@link createConsoleIo}) is clack-backed; tests inject their own.
 */
export interface Io {
  info(message: string): void
  warn(message: string): void
  /** Free-text prompt with an optional default (used when the reply is empty). */
  question(prompt: string, defaultValue?: string): Promise<string>
  /** A single-choice menu; returns the chosen option's value. */
  select<T extends string>(
    prompt: string,
    options: readonly { value: T; label: string }[],
    defaultValue: T,
  ): Promise<T>
  /** Like {@link question} but does not echo the typed characters (for secrets/tokens). */
  secret(prompt: string): Promise<string>
  /** Yes/no prompt. */
  confirm(prompt: string, defaultValue: boolean): Promise<boolean>
  /** Open a URL in the user's default browser (best-effort; resolves even if it can't). */
  openBrowser(url: string): Promise<void>
}

/** How to spawn the OS's URL opener: the command, its argv, and Windows' verbatim-argv flag. */
export interface OpenBrowserCommand {
  cmd: string
  args: string[]
  /**
   * Windows only: hand the joined argv to `CreateProcess` unchanged instead of re-quoting each
   * argument for `CommandLineToArgvW`, whose rules `cmd` does not follow.
   */
  windowsVerbatimArguments?: boolean
}

/**
 * The OS-appropriate command for opening a URL in the default browser.
 *
 * Windows goes through `cmd`, and cmd splits an UNQUOTED command line on `&` before the `start`
 * builtin ever sees it. Every URL we open carries more than one query parameter, so this used to
 * open the browser at everything up to the first `&` and then try to RUN each remaining parameter
 * as a command: `cat-factory k3s` landed on a bare `?infraSetup=local-k3s` with none of the values
 * the connect form prefills from, and the PAT links dropped their `scopes`.
 *
 * So the URL is quoted, which is also why `start`'s first argument is an empty quoted window title
 * (it reads a leading quoted token as one). The quotes have to reach cmd verbatim, hence the flag.
 *
 * The quoting holds only while the URL carries no `"` of its own, so this SERIALIZES the input
 * rather than trusting the caller to have done it: WHATWG serialization percent-encodes `"` in
 * every component that can carry one and rejects it in a host, so no argument can close the quote
 * and have cmd read the rest as a second command. Input that is not a URL at all throws, rather
 * than reaching a shell as a command line whose meaning nobody has checked; `openBrowser` is
 * best-effort and both call sites print the link before opening it. Inside the quotes cmd still
 * expands a `%NAME%` reference, but the expansion is literal text there: quotes make `&` and its
 * friends inert, and no Windows environment value can contain a `"` to close them, so the worst
 * case is a wrong URL, never a second command.
 *
 * @throws {TypeError} if `url` is not a parsable absolute URL.
 */
export function openCommand(url: string, platform: NodeJS.Platform): OpenBrowserCommand {
  const href = new URL(url).href
  switch (platform) {
    case 'darwin':
      return { cmd: 'open', args: [href] }
    case 'win32':
      return {
        cmd: 'cmd',
        args: ['/c', 'start', '""', `"${href}"`],
        windowsVerbatimArguments: true,
      }
    default:
      return { cmd: 'xdg-open', args: [href] }
  }
}

/** A clack prompt resolved to a cancel symbol (Ctrl-C / Esc): print a notice and exit cleanly. */
function bailIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Cancelled.')
    process.exit(130)
  }
  return value
}

/** The real, console-backed {@link Io}, implemented with `@clack/prompts`. */
export function createConsoleIo(): Io {
  return {
    info(message) {
      // Callers pad messages with leading/trailing newlines for plain-console spacing; clack adds
      // its own, so strip the padding to avoid empty bar lines.
      log.message(message.replace(/^\n+|\n+$/g, ''))
    },
    warn(message) {
      log.warn(message.replace(/^\n+|\n+$/g, ''))
    },
    async question(prompt, defaultValue) {
      const value = bailIfCancelled(
        await text({ message: prompt, placeholder: defaultValue, defaultValue }),
      )
      const trimmed = (value ?? '').trim()
      return trimmed.length > 0 ? trimmed : (defaultValue ?? '')
    },
    async select<T extends string>(
      prompt: string,
      options: readonly { value: T; label: string }[],
      defaultValue: T,
    ) {
      // clack's `Option<Value>` is a conditional type TS can't match against our concrete
      // `{ value, label }` while `Value` is still the generic `T`; the shapes are identical for
      // string values, so cast the option list to satisfy it.
      const value = bailIfCancelled(
        await clackSelect<T>({
          message: prompt,
          options: [...options] as Option<T>[],
          initialValue: defaultValue,
        }),
      )
      return value
    },
    async secret(prompt) {
      // clack's password input masks the typed characters — no readline poking needed.
      const value = bailIfCancelled(await password({ message: prompt }))
      return (value ?? '').trim()
    },
    async confirm(prompt, defaultValue) {
      return bailIfCancelled(await clackConfirm({ message: prompt, initialValue: defaultValue }))
    },
    openBrowser(url) {
      return new Promise<void>((resolve) => {
        try {
          const { cmd, args, windowsVerbatimArguments } = openCommand(url, process.platform)
          const child = spawn(cmd, args, {
            stdio: 'ignore',
            detached: true,
            windowsVerbatimArguments,
          })
          child.on('error', () => resolve())
          child.unref()
          resolve()
        } catch {
          resolve()
        }
      })
    },
  }
}
