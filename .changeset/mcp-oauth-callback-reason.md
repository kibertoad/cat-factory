---
'@cat-factory/app': patch
---

The MCP OAuth callback page now says why the backend refused a grant. It read the error from a field the API client does not set, so every refusal showed the same generic line. The page now renders the refusal through the shared inline `FailureMessage`: translated copy for the status class or reason, the backend's message behind "Show details", and "Copy details". Each reason the grant can be refused with has its own copy, and the page says to start the connection again where that helps.
