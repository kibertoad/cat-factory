---
'@cat-factory/app': patch
---

Explore the monorepo for a bootstrap's service directory instead of only typing it

Every other repo path the SPA collects can be browsed: the compose file, the manifests, the
guideline directories, the context documents, the directories an existing monorepo's services
are pinned to. The one that could not was the bootstrap launch form's **Service directory**,
which is also the one whose value the run refuses when it is wrong: "it must not exist yet" was
stated in the field's description and checked nowhere until the API answered
`monorepo_directory_taken`.

A new directory has nothing in the tree to select, so `RepoTreeBrowser` gains `newDirName`: in
`dir` mode it picks WHERE that name goes rather than an existing folder, emits the folder plus
the name (the repo root included), and refuses a folder whose listing already holds it. The
field keeps the text input as its value, so a typed path still works and a typed leaf survives
a trip through the tree.
