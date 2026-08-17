---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Validate an org-supplied URL with the parser that will dial it, and refuse a redirect-origin
allowlist entry that can never match.

The SSRF write-boundary guard picked the authority out of the string with a regex, so it answered a
question `fetch` never asked: `https://10.0.0.5\.acme.atlassian.net` is one host to the guard and
`10.0.0.5` to the request. It now parses with the WHATWG `URL`, and the host classifier decodes IPv6
literals and the DNS root dot instead of matching text (`0:0:0:0:0:0:0:1` and `localhost.` were
admitted; `fdgroup.atlassian.net` was refused as a private address).

`AUTH_ALLOWED_REDIRECT_ORIGINS` entries are parsed in one shared place, and an entry that is not an
http(s) origin now fails the boot naming itself instead of being kept verbatim, where it silently
disabled the allowance it was meant to grant.

Internal API break: `assertSafePublicUrl`, `assertSafeAtlassianBaseUrl`, `normalizeAtlassianBaseUrl`
and the `atlassianLogic` namespace now come from `@cat-factory/integrations` rather than
`@cat-factory/kernel`, because the guard parses with a web global kernel's lib deliberately cannot
see.
