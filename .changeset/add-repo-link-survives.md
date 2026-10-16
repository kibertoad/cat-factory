---
'@cat-factory/app': patch
---

An add-repository link (`?addRepo=<owner>/<name>`) now opens the add-service window with the
repository selected. Two things lost it. Signing in from the link reloaded to a bare path, because
the board consumed the link as the session landed and the reload read the URL after that: every
sign-in form now reads where to return to before it signs in. And the window typed the repository
into its picker before the picker mounted, which Nuxt UI's menu clears on mount: it is now typed in
once the menu has mounted.
