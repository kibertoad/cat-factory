// SQLite has no boolean type, so flags are stored as 0/1.

export const bool = (v: number | null): boolean => v === 1
export const intBool = (v: boolean): number => (v ? 1 : 0)
