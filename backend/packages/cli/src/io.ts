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

/** The OS-appropriate command for opening a URL in the default browser. */
function openCommand(url: string): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] }
    case 'win32':
      // `start` is a cmd builtin; the empty "" is the window title arg it requires.
      return { cmd: 'cmd', args: ['/c', 'start', '', url] }
    default:
      return { cmd: 'xdg-open', args: [url] }
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
          const { cmd, args } = openCommand(url)
          const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
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
