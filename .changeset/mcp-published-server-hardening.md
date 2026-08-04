---
'@cat-factory/mcp-server': minor
---

Bring the published MCP server under the repo's publish guards and give it the protocol depth the
generator already had the data for.

The tool table now declares an `outputSchema` for every operation that answers with a JSON object and
returns `structuredContent` beside the text, so a host or agent framework can consume a result without
re-parsing prose. Those schemas are rendered deliberately loosely (no `required`, no `enum`, no closed
`anyOf`, no bounds, and for a union not even `type`): a caller's MCP client validates against them and
`/api/v1` is additive forever, so anything stricter would let an older copy of this package reject a
newer deployment's honest answer. `destructiveHint` / `idempotentHint` are now set on the operations whose consequence is real
money or a merged pull request, and left unset elsewhere so the protocol's cautious defaults stand.

Two behaviour changes to know about:

- **A result over `CAT_FACTORY_MCP_MAX_RESULT_CHARS` is now refused rather than truncated**, with a
  message naming the size, the limit and the way out (`limit` / `cursor` / `offset`, or a bigger cap).
  Half an object cannot satisfy the output schema it was cut out of, and the old `[TRUNCATED]` prefix
  spent the whole cap delivering the instruction to narrow instead of reading on.
- **Results are compact JSON**, not two-space indented.

New configuration: `CAT_FACTORY_API_KEY_FILE` reads the key from a file instead of the host's
plaintext config (setting both is refused, not resolved by precedence), and
`CAT_FACTORY_MCP_TOOLS` / `CAT_FACTORY_MCP_EXCLUDE_TOOLS` filter per tool beside the existing group
filter, so withholding the PR-merging `notifications_act` no longer costs the whole inbox group. Every
filter is stated in the server's instructions, and a combination that would expose no tools at all
fails at startup.
