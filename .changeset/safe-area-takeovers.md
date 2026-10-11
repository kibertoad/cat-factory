---
'@cat-factory/app': patch
---

The observability, reports, operator dashboard and Kaizen takeovers and the artifact lightbox pad
by the device's safe-area inset and cap to the dynamic viewport, so their headers, close buttons
and bottom edges no longer sit under a phone's notch, home indicator or browser chrome. On a phone,
the observability and operator dashboard headers put their tabs on a second row, so the close
button stays on screen. The sidebar drawer pads its top and inline-start insets, and the
inspector's bottom sheet pads its side insets. A tap in the lightbox's inset strips no longer
closes it.

Every full-screen overlay now takes its root classes from `utils/safeArea.ts`
(`FULL_BLEED_TAKEOVER_CLASS`, `WINDOWED_OVERLAY_CLASS`), which replace the exported
`SAFE_AREA_INSET_CLASS` and `SAFE_AREA_GUTTER_CLASS`.
