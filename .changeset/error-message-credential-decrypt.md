---
'@cat-factory/server': patch
'@cat-factory/integrations': patch
---

Elaborate credential-decryption failure messages (error-message coverage initiative, items
E1/E2). A wrong personal-subscription password and a corrupt/truncated stored secret used to
surface as opaque Web Crypto errors instead of an actionable remedy.

- **E1** — `WebCryptoPersonalSecretCipher.open` (`@cat-factory/server`) now wraps the AES-GCM
  authentication failure the same way the system cipher already wraps a rotated-key failure: the
  opaque `DOMException` ("The operation failed for an operation-specific reason") becomes "The
  personal password does not match the one this subscription was sealed under — re-enter it, or
  remove and re-add the subscription.", preserving the original as `cause`.
  `PersonalSubscriptionService.unlock` keeps its `wrong_password` reason (the 428 flow the SPA
  drives) and now carries a clean, self-sufficient message rather than nesting the raw cipher
  text in parentheses.
- **E2** — the malformed-envelope guards in both ciphers (`WebCryptoSecretCipher.decrypt` and
  `WebCryptoPersonalSecretCipher.open`) now name the likely causes (truncated/corrupted column,
  or a value written under a different scheme/key) and the re-enter/re-seal remedy, instead of a
  terse `Invalid secret envelope`. The integrity-check failure (magic prefix absent after a
  successful GCM decrypt) is distinguished from a wrong password as corruption/tampering.

Also fixes a test-config gap: `@cat-factory/server`'s vitest `include` omitted the co-located
`src/**/*.test.ts` unit tests (the crypto ciphers, provider capabilities, …), so those suites
silently never ran; the glob now covers both `test/*.spec.ts` and `src/**/*.test.ts`.

No behaviour changes beyond error message text.
