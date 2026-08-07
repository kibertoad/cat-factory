---
'@cat-factory/app': patch
---

Say what to change when a step's tool server (MCP) was dropped, not only why.

The step's tool-server section stated the reason a declared server was not wired and stopped there,
which leaves an operator holding an accurate diagnosis and no next step: the reason was already
stated to the agent in its own prompt, and restating it to a person is only worth a surface if it
also names the thing to change. Each reason now renders its remedy beneath it, one per member of
the vocabulary, since needing a different fix is what makes each member its own member. A reason
this build no longer recognises renders its raw code with no remedy, because there is no surface
it could honestly send anyone to.

Each remedy covers every cause its reason is reached from, which is not the same as covering the
obvious one. `harness_unsupported` also fires for an ambient-auth Codex run, where the CLI already
speaks MCP and is already allowed and only a leased credential helps; `missing_secret` comes from a
composed resolver whose default half is a deployment environment variable, not the workspace
credential store; `oauth_not_connected` also fires where no grant store is wired at all. A line
naming one cause of three would cost an operator the attempt as well as the answer.
