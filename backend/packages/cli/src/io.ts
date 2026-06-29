import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Terminal I/O seam. The orchestrator depends on this interface (never on `process`/`readline`
 * directly), so the whole interactive flow can be driven by a fake in tests.
 */
export interface Io {
  info(message: string): void
  warn(message: string): void
  /** Free-text prompt with an optional default (shown in brackets, used when the reply is empty). */
  question(prompt: string, defaultValue?: string): Promise<string>
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

/** The real, console-backed {@link Io}. */
export function createConsoleIo(): Io {
  const rl = () => createInterface({ input: process.stdin, output: process.stdout })

  return {
    info(message) {
      process.stdout.write(`${message}\n`)
    },
    warn(message) {
      process.stderr.write(`${message}\n`)
    },
    question(prompt, defaultValue) {
      const suffix = defaultValue ? ` [${defaultValue}]` : ''
      const iface = rl()
      return new Promise<string>((resolve) => {
        iface.question(`${prompt}${suffix}: `, (answer) => {
          iface.close()
          const trimmed = answer.trim()
          resolve(trimmed.length > 0 ? trimmed : (defaultValue ?? ''))
        })
      })
    },
    secret(prompt) {
      const iface = rl()
      // Mute the output so typed characters (the token) aren't echoed to the terminal.
      const muted = iface as unknown as { _writeToOutput?: (s: string) => void }
      const original = muted._writeToOutput?.bind(iface)
      let muting = false
      muted._writeToOutput = (s: string) => {
        if (muting) {
          // Still emit newlines so the cursor advances when the user hits enter.
          if (s.includes('\n')) process.stdout.write('\n')
          return
        }
        process.stdout.write(s)
      }
      return new Promise<string>((resolve) => {
        iface.question(`${prompt}: `, (answer) => {
          if (original) muted._writeToOutput = original
          iface.close()
          resolve(answer.trim())
        })
        muting = true
      })
    },
    async confirm(prompt, defaultValue) {
      const hint = defaultValue ? 'Y/n' : 'y/N'
      const answer = (await this.question(`${prompt} (${hint})`)).toLowerCase()
      if (answer === '') return defaultValue
      return answer === 'y' || answer === 'yes'
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
