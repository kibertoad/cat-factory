import type { EmailMessage, EmailSender } from '@cat-factory/kernel'

// Transactional email adapters behind the single EmailSender port — mirroring how the
// model registry composes vendor resolvers. Built on `fetch` only, so they run on both
// Cloudflare workerd and Node. A facade picks whichever provider is configured.

export interface SendGridConfig {
  apiKey: string
  from: string
}

/** SendGrid v3 mail-send adapter. */
export class SendGridEmailSender implements EmailSender {
  constructor(private readonly config: SendGridConfig) {}

  async send(message: EmailMessage): Promise<void> {
    const content: { type: string; value: string }[] = []
    if (message.text) content.push({ type: 'text/plain', value: message.text })
    content.push({ type: 'text/html', value: message.html })
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: this.config.from },
        subject: message.subject,
        content,
      }),
    })
    if (!res.ok) {
      throw new Error(`SendGrid send failed (HTTP ${res.status}): ${await safeBody(res)}`)
    }
  }
}

export interface ResendConfig {
  apiKey: string
  from: string
}

/** Resend email-send adapter. */
export class ResendEmailSender implements EmailSender {
  constructor(private readonly config: ResendConfig) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        ...(message.text ? { text: message.text } : {}),
      }),
    })
    if (!res.ok) {
      throw new Error(`Resend send failed (HTTP ${res.status}): ${await safeBody(res)}`)
    }
  }
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}

export interface EmailProviderConfig {
  provider: 'sendgrid' | 'resend' | null
  from: string
  sendgrid?: { apiKey: string }
  resend?: { apiKey: string }
}

/**
 * Build the configured EmailSender, or null when no provider is set. The opt-in seam
 * the facades use: unconfigured ⇒ the email-dependent features simply aren't wired.
 */
export function createEmailSender(config: EmailProviderConfig): EmailSender | null {
  if (config.provider === 'sendgrid' && config.sendgrid?.apiKey) {
    return new SendGridEmailSender({ apiKey: config.sendgrid.apiKey, from: config.from })
  }
  if (config.provider === 'resend' && config.resend?.apiKey) {
    return new ResendEmailSender({ apiKey: config.resend.apiKey, from: config.from })
  }
  return null
}
