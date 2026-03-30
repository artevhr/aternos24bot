const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const config = require('./config')

// Ensure data directory exists
const dir = path.dirname(config.DB_PATH)
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

const db = new Database(config.DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id       INTEGER UNIQUE NOT NULL,
    username          TEXT,
    sequential_id     INTEGER UNIQUE,
    premium_type      TEXT DEFAULT NULL,
    premium_expires_at INTEGER DEFAULT NULL,
    last_host         TEXT,
    last_port         INTEGER DEFAULT 25565,
    created_at        INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS seq_counter (
    id  INTEGER PRIMARY KEY,
    val INTEGER DEFAULT 0
  );

  INSERT OR IGNORE INTO seq_counter (id, val) VALUES (1, 0);
`)

function nextSeqId() {
  db.prepare('UPDATE seq_counter SET val = val + 1 WHERE id = 1').run()
  return db.prepare('SELECT val FROM seq_counter WHERE id = 1').get().val
}

const userOps = {
  getOrCreate(telegramId, username) {
    let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId)
    if (!user) {
      const seqId = nextSeqId()
      db.prepare(
        'INSERT INTO users (telegram_id, username, sequential_id) VALUES (?, ?, ?)'
      ).run(telegramId, username || null, seqId)
      user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId)
    } else if (username && user.username !== username) {
      db.prepare('UPDATE users SET username = ? WHERE telegram_id = ?').run(username, telegramId)
      user.username = username
    }
    return user
  },

  get(telegramId) {
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId)
  },

  getAll() {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all()
  },

  saveLastServer(telegramId, host, port) {
    db.prepare('UPDATE users SET last_host = ?, last_port = ? WHERE telegram_id = ?').run(host, port, telegramId)
  },

  setPremium(telegramId, type, expiresAt) {
    db.prepare(
      'UPDATE users SET premium_type = ?, premium_expires_at = ? WHERE telegram_id = ?'
    ).run(type, expiresAt, telegramId)
  },

  removePremium(telegramId) {
    db.prepare(
      'UPDATE users SET premium_type = NULL, premium_expires_at = NULL WHERE telegram_id = ?'
    ).run(telegramId)
  },

  isPremium(telegramId) {
    const user = db.prepare(
      'SELECT premium_type, premium_expires_at FROM users WHERE telegram_id = ?'
    ).get(telegramId)
    if (!user || !user.premium_type) return false
    if (user.premium_type === 'lifetime') return true
    if (user.premium_expires_at && user.premium_expires_at > Math.floor(Date.now() / 1000)) return true
    // Expired — clean up
    db.prepare(
      'UPDATE users SET premium_type = NULL, premium_expires_at = NULL WHERE telegram_id = ?'
    ).run(telegramId)
    return false
  },
}

module.exports = { db, userOps }
