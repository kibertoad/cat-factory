# @cat-factory/acceptance

## 0.0.6

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/sdk@0.33.0

## 0.0.5

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/sdk@0.32.0

## 0.0.4

### Patch Changes

- f6a1a87: Read the acceptance suite's configuration from a `.env` beside its vitest config. The file was
  already gitignored and referenced, but nothing loaded it, so a fully configured `.env` still
  refused with every variable reported as missing. A variable exported in the shell wins over the
  file, so a one-off `ACCEPTANCE_RUN_ID=latest` still resumes.

## 0.0.3

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/sdk@0.32.0

## 0.0.2

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/sdk@0.31.0

## 0.0.1

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/sdk@0.31.0
