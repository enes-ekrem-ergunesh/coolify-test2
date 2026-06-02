const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function openDatabase(databasePath) {
  const absolutePath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const db = new Database(absolutePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_verified INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      type TEXT,
      category TEXT,
      amount REAL,
      currency TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'manual',
      parser_source TEXT NOT NULL DEFAULT 'manual',
      parser_reason TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entries_user_status ON entries(user_id, status, created_at DESC);
  `);

  const entryColumns = db.prepare('PRAGMA table_info(entries)').all();
  const hasDeletedAt = entryColumns.some((column) => column.name === 'deleted_at');
  if (!hasDeletedAt) {
    db.exec('ALTER TABLE entries ADD COLUMN deleted_at TEXT');
  }

  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  const hasIsVerified = userColumns.some((column) => column.name === 'is_verified');
  if (!hasIsVerified) {
    db.exec('ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0');
  }
  const hasVerifiedAt = userColumns.some((column) => column.name === 'verified_at');
  if (!hasVerifiedAt) {
    db.exec('ALTER TABLE users ADD COLUMN verified_at TEXT');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_user_deleted ON entries(user_id, deleted_at, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_verification ON users(is_verified, created_at DESC)');
}

module.exports = {
  openDatabase,
  initDb,
};
