---
'@cat-factory/app': patch
---

Draw the bars in the Reports spend trend and the Operator dashboard outcome trend (#2395). Both charts now share one column component: the minimum height applies once per column instead of to each segment, so columns stay to scale and in rank order; a segment with no value is not drawn; and the rounded corners follow whichever segment is at the top or bottom.
