---
'@cat-factory/app': patch
---

Selecting a service frame no longer reads the GitHub repos, pull requests and issues twice. The inspector and its test-config section both ask for the projection when the frame opens, and concurrent callers now share one read. A connected workspace with no linked repos is also loaded once, not on every inspector open: the store tracks whether the projection is loaded for the workspace, and no longer reads an empty repo list as "not loaded". A failed load, a board reset and a disconnect each make the next request read again. When two reads overlap, an older one that finishes last no longer replaces the newer result, a read for a board you have left no longer lands on the next one, and a read that finishes after a disconnect no longer puts the old rows back.
