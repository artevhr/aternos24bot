const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Ensure data directory exists
const dbDir = path.dirname(path.resolve(config.DB_PATH));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    premium_type TEXT DEFAULT 'free',
    premium_expires INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    bot_number INTEGER NOT NULL,
    server_host TEXT NOT NULL,
    server_port INTEGER DEFAULT 25565,
    mc_version TEXT NOT NULL,
    mc_username TEXT NOT NULL,
    status TEXT DEFAULT 'disconnected',
    connected_at INTEGER,
    disconnected_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    payment_type TEXT NOT NULL,
    method TEXT NOT NULL,
    amount TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS bot_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    count INTEGER DEFAULT 0
  );

  INSERT OR IGNORE INTO bot_counter VALUES (1, 0);
`);

module.exports = {
  // ===== USERS =====
  getUser: (telegramId) =>
    db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId),

  getUserByInternalId: (id) =>
    db.prepare('SELECT * FROM users WHERE id = ?').get(id),

  createUser: (telegramId, username) => {
    db.prepare('INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)').run(telegramId, username || '');
    return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  },

  updateUserPremium: (telegramId, type, expires) =>
    db.prepare('UPDATE users SET premium_type = ?, premium_expires = ? WHERE telegram_id = ?').run(type, expires, telegramId),

  getAllUsers: () =>
    db.prepare('SELECT * FROM users ORDER BY created_at DESC').all(),

  // ===== BOTS =====
  getNextBotNumber: () => {
    db.prepare('UPDATE bot_counter SET count = count + 1 WHERE id = 1').run();
    return db.prepare('SELECT count FROM bot_counter WHERE id = 1').get().count;
  },

  createBot: (userId, botNumber, host, port, version) => {
    const username = `whminebot-${botNumber}`;
    return db.prepare(
      'INSERT INTO bots (user_id, bot_number, server_host, server_port, mc_version, mc_username) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, botNumber, host, port, version, username).lastInsertRowid;
  },

  getActiveBot: (userId) =>
    db.prepare("SELECT * FROM bots WHERE user_id = ? AND status = 'connected' ORDER BY id DESC LIMIT 1").get(userId),

  getBotById: (id) =>
    db.prepare('SELECT * FROM bots WHERE id = ?').get(id),

  updateBotStatus: (id, status) => {
    const now = Math.floor(Date.now() / 1000);
    if (status === 'connected') {
      db.prepare('UPDATE bots SET status = ?, connected_at = ? WHERE id = ?').run(status, now, id);
    } else {
      db.prepare('UPDATE bots SET status = ?, disconnected_at = ? WHERE id = ?').run(status, now, id);
    }
  },

  getAllActiveBots: () =>
    db.prepare("SELECT b.*, u.telegram_id FROM bots b JOIN users u ON b.user_id = u.id WHERE b.status = 'connected'").all(),

  // ===== PAYMENTS =====
  createPayment: (userId, telegramId, type, method, amount) =>
    db.prepare('INSERT INTO payments (user_id, telegram_id, payment_type, method, amount) VALUES (?, ?, ?, ?, ?)')
      .run(userId, telegramId, type, method, amount).lastInsertRowid,

  updatePayment: (id, status) =>
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, id),

  getPendingPayments: () =>
    db.prepare("SELECT p.*, u.username FROM payments p JOIN users u ON p.user_id = u.id WHERE p.status = 'pending' ORDER BY p.created_at DESC").all(),
};
