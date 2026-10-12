---
'@cat-factory/app': patch
---

The model configuration opened from the pipeline builder now takes clicks. It replaces the builder while it is open, and the builder comes back with its draft when the model configuration closes. Before, the builder stayed open under it and took every click.
