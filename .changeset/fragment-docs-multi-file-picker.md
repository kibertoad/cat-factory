---
'@cat-factory/app': patch
---

The fragment library's "Documents" tab GitHub picker now stages multiple files
from anywhere in the repo tree (across nesting levels) and links each as its own
living fragment in one action, instead of allowing only a single file. Repos
reachable only through the signed-in user's personal token are badged
("personal (your token)") in the fragment and context-document repo pickers, so
it's clear up front that linking one relies on that token (on hosted, where a
fragment resolves through the workspace App at run time, such a link surfaces a
clear error rather than silently succeeding).
