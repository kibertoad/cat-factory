// The bytes a stored artifact serves. Screenshots, visual evidence and binary outputs load through
// `GET /workspaces/:ws/artifacts/:artifactId/blob`, which has no route contract and answers raw
// bytes, so `artifactBlobResponse` in `api.ts` answers it with these.

/** A 240x150 PNG that reads as a page screenshot: a dark header bar, a light body, one card. */
export const screenshotPng = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABiElEQVR42u3SsQ2AIABEUSaxZwbHMWF/CgoraKkxQcF3+RNcXjjiKW1TcIGAloCWgJaAFtAS0BLQEtAS0AJaAloCWgJaAlpAS0BLQEtAS0ALaGk50Lnc0jYBLaAloCWgJaAFtAS0BLQEtAS0gJaAloCWgJaAFtAS0BLQEtAS0AJa+i/oK2VpOKAFNNACGmgBLQEtoIEW0EALaKAFtAS0gAZaQAMtoIEW0BLQAvpN0NXswYA2oIE2oIE2oM2ANqCBNqCBNqCBNqDNgDaggTaggTaggTagzYA2oIE2oIE2oIE2oM2ANqCBNqCBNqCBNqDNgDaggTaggTaggTagzYA2oIE2oIE2oM2ANgPagAbagAbagDYD2oAG2oAG2oAG2oA2A9qABtqABtqABtqANgPagAbagAbagAbagDYD2oAG2oAG2oAG2oA2A9qAng9a+kJAC2gJaAloCWgBLQEtAS0BLQEtoCWgJaAloCWgBbQEtAS0BLQEtICWgJaAloCWgBbQEtAS0BLQUlcDGaGfh+BtvOkAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
)

/**
 * The same page as `screenshotPng` with its card 8px lower: a reference that differs a little from
 * the screenshot, for the image compare modes and their diff.
 */
export const referencePng = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAABiElEQVR42u3SwQ2AIBREwV+Jd2qgHBP758CBE/SgEYXM5lWwmThSlrYpXCCgJaAloCWgBbQEtAS0BLQEtICWgJaAloCWgBbQEtAS0BLQEtACWloOdKlN2iagBbQEtAS0BLSAloCWgJaAloAW0BLQEtAS0BLQAloCWgJaAloCWkBLQEtAS0BLQAtoCWgJaAlo6Q3Q51Wk2wEtoIEW0EALaAloAQ20gAZaQAMtoCWgBTTQAhpoAQ20gJaAFtBfgu5mDwa0AQ20AQ20AW0GtAENtAENtAENtAFtBrQBDbQBDbQBDbQBbQa0AQ20AQ20AQ20AW0GtAENtAENtAENtAFtBrQBDbQBDbQBDbQBbQa0AQ20AQ20AW0GtBnQBjTQBjTQBrQZ0AY00AY00AY00Aa0GdAGNNAGNNAGNNAGtBnQBjTQBjTQBjTQBrQZ0AY00AY00AY00Aa0GdAG9HzQ0h8CWkBLQEtAS0ALaAloCWgJaAloAS0BLQEtAS0BLaAloCWgJaAloAW0tFwD9cSfh9vzUQYAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
)
