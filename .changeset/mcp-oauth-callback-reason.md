---
'@cat-factory/app': patch
---

The MCP OAuth callback page now says why the backend refused a grant. It read the error from a field the API client does not set, so every refusal showed the same generic line. The page now describes the refusal in translated copy from its status class or reason, with the backend's message behind "Show details", through the same classifier the failure toasts use.
