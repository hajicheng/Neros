import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { bootstrapDatabase } from './bootstrap'

const DATA_DIR =
  process.env.NEROS_DATA_DIR ??
  path.resolve(/* turbopackIgnore: true */ process.cwd(), '.neros-data')
const DB_PATH = path.join(DATA_DIR, 'neros.db')

mkdirSync(DATA_DIR, { recursive: true })

const globalForDb = globalThis as unknown as {
  nerosSqlite?: Database.Database
}

const sqlite =
  globalForDb.nerosSqlite ??
  new Database(DB_PATH, {
    fileMustExist: false,
  })

if (!globalForDb.nerosSqlite) {
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  globalForDb.nerosSqlite = sqlite
}

bootstrapDatabase(sqlite, DATA_DIR)

export { DATA_DIR, DB_PATH, sqlite }
