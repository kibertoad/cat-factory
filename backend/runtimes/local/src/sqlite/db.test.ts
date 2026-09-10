import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDb, queryAll } from './db.js'

// The shared open sequence for every local `node:sqlite` store. What is worth pinning here is the
// one thing `CREATE TABLE IF NOT EXISTS` cannot say on its own: a column added to a shipped schema
// has to reach a file that already holds the table, or every read of it fails on someone's laptop
// with `no such column` and nothing but "delete the file" to offer.
//
// Against real files rather than `:memory:`, because the whole behaviour is about REOPENING one.

const dirs: string[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cat-sqlite-'))
  dirs.push(dir)
  return join(dir, 'store.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function columnNames(path: string, table: string): string[] {
  const db = new DatabaseSync(path)
  try {
    return queryAll<{ name: string }>(db, `PRAGMA table_info("${table}")`).map((c) => c.name)
  } finally {
    db.close()
  }
}

const V1 = `CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_tokens ON metrics (tokens);`

const V2 = `CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL DEFAULT 0,
  spend_only INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_tokens ON metrics (tokens);
CREATE TABLE IF NOT EXISTS later_arrival (id TEXT PRIMARY KEY);`

describe('openSqliteDb', () => {
  it('adds the columns a shipped schema gained to a file that predates them', () => {
    const path = tempDbPath()
    const v1 = openSqliteDb(path, V1)
    v1.prepare('INSERT INTO metrics (id, tokens) VALUES (?, ?)').run('a', 7)
    v1.close()

    openSqliteDb(path, V2).close()

    expect(columnNames(path, 'metrics')).toEqual(['id', 'tokens', 'spend_only', 'note'])
    // The declared DEFAULT is what a pre-existing row now reads as, so a query selecting the new
    // column gets the answer the schema states rather than a NULL the column forbids.
    const db = new DatabaseSync(path)
    try {
      expect(
        queryAll<{ id: string; spend_only: number; note: string | null }>(
          db,
          'SELECT id, spend_only, note FROM metrics',
        ),
      ).toEqual([{ id: 'a', spend_only: 0, note: null }])
    } finally {
      db.close()
    }
  })

  it('still creates the tables the schema gained outright, and keeps existing rows', () => {
    const path = tempDbPath()
    const v1 = openSqliteDb(path, V1)
    v1.prepare('INSERT INTO metrics (id, tokens) VALUES (?, ?)').run('a', 7)
    v1.close()

    const v2 = openSqliteDb(path, V2)
    try {
      expect(v2.prepare('SELECT count(*) AS n FROM later_arrival').get()).toEqual({ n: 0 })
      expect(v2.prepare('SELECT tokens FROM metrics WHERE id = ?').get('a')).toEqual({ tokens: 7 })
    } finally {
      v2.close()
    }
  })

  it('is additive only: a column the schema dropped is left alone', () => {
    // Reversing the two schemas. Removing a column means rebuilding the table, which is a data
    // decision this local state does not earn — and a store that silently discarded a column would
    // be far worse than one carrying a stale one.
    const path = tempDbPath()
    openSqliteDb(path, V2).close()
    openSqliteDb(path, V1).close()

    expect(columnNames(path, 'metrics')).toContain('spend_only')
  })

  it('reopening an already-current file changes nothing', () => {
    const path = tempDbPath()
    openSqliteDb(path, V2).close()
    openSqliteDb(path, V2).close()

    expect(columnNames(path, 'metrics')).toEqual(['id', 'tokens', 'spend_only', 'note'])
  })

  it('rebuilds a table the store declared rebuildable when its columns moved', () => {
    // The rename case, which is what a shipped store actually hits: `subscription_activations`
    // renamed `execution_id` to `scope_id`, and an additive reconcile can only read that as
    // adding a `NOT NULL` column with no default, which SQLite refuses on a populated table, so
    // the store would stop opening over state that expires in hours.
    const path = tempDbPath()
    const before = `CREATE TABLE IF NOT EXISTS activations (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      token TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activations_scope ON activations (execution_id);`
    const v1 = openSqliteDb(path, before, { rebuildable: ['activations'] })
    v1.prepare('INSERT INTO activations (id, execution_id, token) VALUES (?, ?, ?)').run(
      'a',
      'exec_1',
      'secret',
    )
    v1.close()

    const after = `CREATE TABLE IF NOT EXISTS activations (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      token TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activations_scope ON activations (scope_id);`
    const v2 = openSqliteDb(path, after, { rebuildable: ['activations'] })
    try {
      expect(columnNames(path, 'activations')).toEqual(['id', 'scope_id', 'token'])
      // The rows went with the shape, which is the whole cost of the option: an INSERT naming the
      // declared columns works, where the leftover `execution_id NOT NULL` would have failed it.
      expect(v2.prepare('SELECT count(*) AS n FROM activations').get()).toEqual({ n: 0 })
      v2.prepare('INSERT INTO activations (id, scope_id, token) VALUES (?, ?, ?)').run(
        'b',
        'user:usr_1',
        'secret',
      )
    } finally {
      v2.close()
    }
  })

  it('leaves a rebuildable table alone while its columns still match', () => {
    // Rebuilding is for a shape that MOVED, not for every open: a store that dropped its rows on
    // each boot would cost a password prompt per restart.
    const path = tempDbPath()
    const schema = 'CREATE TABLE IF NOT EXISTS activations (id TEXT PRIMARY KEY, token TEXT);'
    const v1 = openSqliteDb(path, schema, { rebuildable: ['activations'] })
    v1.prepare('INSERT INTO activations (id, token) VALUES (?, ?)').run('a', 'secret')
    v1.close()

    const v2 = openSqliteDb(path, schema, { rebuildable: ['activations'] })
    try {
      expect(v2.prepare('SELECT token FROM activations WHERE id = ?').get('a')).toEqual({
        token: 'secret',
      })
    } finally {
      v2.close()
    }
  })

  it('refuses to open when a rebuildable name is not a table the schema declares', () => {
    // A typo reads as "this table is never rebuilt", which is the failure the option exists to
    // prevent, arriving later and looking like something else.
    const path = tempDbPath()

    expect(() => openSqliteDb(path, V1, { rebuildable: ['metric'] })).toThrow(
      /"metric".*rebuildable/s,
    )
  })

  it('refuses to open on a column SQLite cannot add, naming the file and the column', () => {
    // `NOT NULL` with no default is the shape `ALTER TABLE ADD COLUMN` rejects once the table holds
    // rows — which is every case that matters, since an empty file would have been created from the
    // current schema anyway. Failing HERE, once, beats serving a store whose every read of that
    // column throws, and the message has to carry enough to act on: the schema is not in front of
    // whoever hit it.
    const path = tempDbPath()
    const v1 = openSqliteDb(path, V1)
    v1.prepare('INSERT INTO metrics (id, tokens) VALUES (?, ?)').run('a', 7)
    v1.close()

    const impossible = `CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      tokens INTEGER NOT NULL DEFAULT 0,
      required TEXT NOT NULL
    );`
    expect(() => openSqliteDb(path, impossible)).toThrow(/"required".*"metrics"/s)
    expect(() => openSqliteDb(path, impossible)).toThrow(path)
  })
})
