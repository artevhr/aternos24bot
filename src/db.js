const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const DB_PATH = path.resolve(config.DB_PATH);
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

let db;

const ready = initSqlJs().then((SQL) => {
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA foreign_keys = ON;`);
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      premium_type TEXT DEFAULT 'free',
      premium_expires INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
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
      disconnected_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      telegram_id INTEGER NOT NULL,
      payment_type TEXT NOT NULL,
      method TEXT NOT NULL,
      amount TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS bot_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      count INTEGER DEFAULT 0
    );
    INSERT OR IGNORE INTO bot_counter VALUES (1, 0);
  `);

  persist();
  setInterval(persist, 30000);
});

function persist() {
  if (!db) return;
  try {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  } catch (e) {
    console.error('DB persist error:', e.message);
  }
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) { const r = stmt.getAsObject(); stmt.free(); return r; }
  stmt.free();
  return undefined;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  const r = get('SELECT last_insert_rowid() as id');
  persist();
  return r ? r.id : null;
}

module.exports = {
  ready,
  getUser: (tid) => get('SELECT * FROM users WHERE telegram_id = ?', [tid]),
  getUserByInternalId: (id) => get('SELECT * FROM users WHERE id = ?', [id]),
  createUser: (tid, username) => {
    run('INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)', [tid, username || '']);
    return get('SELECT * FROM users WHERE telegram_id = ?', [tid]);
  },
  updateUserPremium: (tid, type, expires) =>
    run('UPDATE users SET premium_type = ?, premium_expires = ? WHERE telegram_id = ?', [type, expires, tid]),
  getAllUsers: () => all('SELECT * FROM users ORDER BY created_at DESC'),
  getNextBotNumber: () => {
    db.run('UPDATE bot_counter SET count = count + 1 WHERE id = 1');
    const r = get('SELECT count FROM bot_counter WHERE id = 1');
    persist();
    return r ? r.count : 1;
  },
  createBot: (userId, botNumber, host, port, version) =>
    run(
      'INSERT INTO bots (user_id, bot_number, server_host, server_port, mc_version, mc_username) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, botNumber, host, port, version, `whminebot-${botNumber}`]
    ),
  getActiveBot: (userId) =>
    get("SELECT * FROM bots WHERE user_id = ? AND status = 'connected' ORDER BY id DESC LIMIT 1", [userId]),
  getBotById: (id) => get('SELECT * FROM bots WHERE id = ?', [id]),
  updateBotStatus: (id, status) => {
    const now = Math.floor(Date.now() / 1000);
    if (status === 'connected') {
      run('UPDATE bots SET status = ?, connected_at = ? WHERE id = ?', [status, now, id]);
    } else {
      run('UPDATE bots SET status = ?, disconnected_at = ? WHERE id = ?', [status, now, id]);
    }
  },
  getAllActiveBots: () =>
    all("SELECT b.*, u.telegram_id FROM bots b JOIN users u ON b.user_id = u.id WHERE b.status = 'connected'"),
  createPayment: (userId, tid, type, method, amount) =>
    run('INSERT INTO payments (user_id, telegram_id, payment_type, method, amount) VALUES (?, ?, ?, ?, ?)',
      [userId, tid, type, method, amount]),
  updatePayment: (id, status) => run('UPDATE payments SET status = ? WHERE id = ?', [status, id]),
  getPendingPayments: () =>
    all("SELECT p.*, u.username FROM payments p JOIN users u ON p.user_id = u.id WHERE p.status = 'pending' ORDER BY p.created_at DESC"),
  persist,
};
