const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const DB_PATH = path.resolve(config.DB_PATH);
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

const ready = initSqlJs().then((SQL) => {
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON;');
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      username TEXT,
      premium_type TEXT DEFAULT 'free',
      premium_expires INTEGER,
      custom_bot_nick TEXT,
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
      disconnected_at INTEGER,
      total_online_seconds INTEGER DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS promocodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      days INTEGER NOT NULL,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS promo_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      telegram_id INTEGER NOT NULL,
      used_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      version TEXT NOT NULL,
      last_used INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(telegram_id, host, port)
    );
    CREATE TABLE IF NOT EXISTS mc_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      nick TEXT NOT NULL,
      last_used INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(telegram_id, nick)
    );
    CREATE TABLE IF NOT EXISTS saved_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 25565,
      version TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(telegram_id, host, port)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      bot_username TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      version TEXT NOT NULL,
      connected_at INTEGER NOT NULL,
      disconnected_at INTEGER,
      duration_seconds INTEGER DEFAULT 0,
      disconnect_reason TEXT DEFAULT 'manual'
    );
    INSERT OR IGNORE INTO bot_counter VALUES (1, 0);
  `);
  // Seed default settings if not set
  const defaults = {
    price_monthly_stars: config.DEFAULT_PRICE_MONTHLY_STARS,
    price_eternal_stars: config.DEFAULT_PRICE_ETERNAL_STARS,
    price_upgrade_stars: config.DEFAULT_PRICE_UPGRADE_STARS,
    crypto_monthly_usd: config.DEFAULT_CRYPTO_MONTHLY_USD,
    crypto_eternal_usd: config.DEFAULT_CRYPTO_ETERNAL_USD,
    card_number: config.DEFAULT_CARD_NUMBER,
    card_holder: config.DEFAULT_CARD_HOLDER,
    card_monthly_price: config.DEFAULT_CARD_MONTHLY_PRICE,
    card_eternal_price: config.DEFAULT_CARD_ETERNAL_PRICE,
    payment_stars_enabled: '1',
    payment_crypto_enabled: '1',
    payment_card_enabled: '1',
  };
  for (const [k, v] of Object.entries(defaults)) {
    db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, String(v)]);
  }
  persist();
  setInterval(persist, 30000);
});

function persist() {
  if (!db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch (e) { console.error('DB persist error:', e.message); }
}
function get(sql, p = []) {
  const s = db.prepare(sql); s.bind(p);
  if (s.step()) { const r = s.getAsObject(); s.free(); return r; }
  s.free(); return undefined;
}
function all(sql, p = []) {
  const s = db.prepare(sql); s.bind(p);
  const rows = []; while (s.step()) rows.push(s.getAsObject()); s.free(); return rows;
}
function run(sql, p = []) {
  db.run(sql, p);
  const r = get('SELECT last_insert_rowid() as id');
  persist(); return r ? r.id : null;
}

module.exports = {
  ready, persist,
  // ── USERS
  getUser: t => get('SELECT * FROM users WHERE telegram_id = ?', [t]),
  getUserByInternalId: id => get('SELECT * FROM users WHERE id = ?', [id]),
  createUser: (t, u) => { run('INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)', [t, u||'']); return get('SELECT * FROM users WHERE telegram_id = ?', [t]); },
  updateUserPremium: (t, type, expires) => run('UPDATE users SET premium_type = ?, premium_expires = ? WHERE telegram_id = ?', [type, expires, t]),
  updateCustomNick: (t, nick) => run('UPDATE users SET custom_bot_nick = ? WHERE telegram_id = ?', [nick||null, t]),
  getAllUsers: () => all('SELECT * FROM users ORDER BY created_at DESC'),
  countUsers: () => { const r = get('SELECT COUNT(*) as c FROM users'); return r ? r.c : 0; },
  countPremiumUsers: () => {
    const now = Math.floor(Date.now()/1000);
    const r = get(`SELECT COUNT(*) as c FROM users WHERE premium_type='eternal' OR (premium_type='monthly' AND premium_expires > ?)`, [now]);
    return r ? r.c : 0;
  },
  getUsersExpiringIn24h: () => {
    const now = Math.floor(Date.now()/1000);
    return all(`SELECT * FROM users WHERE premium_type='monthly' AND premium_expires > ? AND premium_expires <= ?`, [now, now+86400]);
  },
  getUsersExpiringIn3Days: () => {
    const now = Math.floor(Date.now()/1000);
    return all(`SELECT * FROM users WHERE premium_type='monthly' AND premium_expires > ? AND premium_expires <= ?`, [now, now+3*86400]);
  },
  // ── BOTS
  getNextBotNumber: () => {
    db.run('UPDATE bot_counter SET count = count + 1 WHERE id = 1');
    const r = get('SELECT count FROM bot_counter WHERE id = 1'); persist(); return r ? r.count : 1;
  },
  createBot: (userId, botNumber, host, port, version, username) =>
    run('INSERT INTO bots (user_id, bot_number, server_host, server_port, mc_version, mc_username) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, botNumber, host, port, version, username || `whminebot-${botNumber}`]),
  getActiveBotsForUser: (userId) =>
    all("SELECT * FROM bots WHERE user_id = ? AND status = 'connected' ORDER BY id DESC", [userId]),
  getActiveBot: (userId) =>
    get("SELECT * FROM bots WHERE user_id = ? AND status = 'connected' ORDER BY id DESC LIMIT 1", [userId]),
  getLastBot: (userId) => get('SELECT * FROM bots WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]),
  getBotById: id => get('SELECT * FROM bots WHERE id = ?', [id]),
  updateBotStatus: (id, status) => {
    const now = Math.floor(Date.now()/1000);
    if (status === 'connected') {
      run('UPDATE bots SET status = ?, connected_at = ? WHERE id = ?', [status, now, id]);
    } else {
      const bot = get('SELECT connected_at, total_online_seconds FROM bots WHERE id = ?', [id]);
      const extra = bot?.connected_at ? Math.max(0, now - bot.connected_at) : 0;
      run('UPDATE bots SET status = ?, disconnected_at = ?, total_online_seconds = ? WHERE id = ?',
        [status, now, (bot?.total_online_seconds||0)+extra, id]);
    }
  },
  getTotalOnlineSeconds: (userId) => {
    const r = get('SELECT SUM(total_online_seconds) as t FROM bots WHERE user_id = ?', [userId]); return r?.t || 0;
  },
  getAllActiveBots: () => all("SELECT b.*, u.telegram_id FROM bots b JOIN users u ON b.user_id=u.id WHERE b.status='connected'"),
  countActiveBots: () => { const r = get("SELECT COUNT(*) as c FROM bots WHERE status='connected'"); return r ? r.c : 0; },
  // ── PAYMENTS
  createPayment: (uid, tid, type, method, amount) =>
    run('INSERT INTO payments (user_id, telegram_id, payment_type, method, amount) VALUES (?, ?, ?, ?, ?)', [uid, tid, type, method, amount]),
  updatePayment: (id, status) => run('UPDATE payments SET status = ? WHERE id = ?', [status, id]),
  getPendingPayments: () => all("SELECT p.*, u.username FROM payments p JOIN users u ON p.user_id=u.id WHERE p.status='pending' ORDER BY p.created_at DESC"),
  countCompletedPayments: () => { const r = get("SELECT COUNT(*) as c FROM payments WHERE status='completed'"); return r ? r.c : 0; },
  // ── PROMOCODES
  createPromocode: (code, days, maxUses, expiresAt) =>
    run('INSERT INTO promocodes (code, days, max_uses, expires_at) VALUES (?, ?, ?, ?)', [code.toUpperCase(), days, maxUses, expiresAt||null]),
  getPromocode: code => get('SELECT * FROM promocodes WHERE code = ?', [code.toUpperCase()]),
  hasUsedPromo: (code, tid) => !!get('SELECT id FROM promo_uses WHERE code=? AND telegram_id=?', [code.toUpperCase(), tid]),
  usePromocode: (code, tid) => {
    run('UPDATE promocodes SET used_count=used_count+1 WHERE code=?', [code.toUpperCase()]);
    run('INSERT INTO promo_uses (code, telegram_id) VALUES (?, ?)', [code.toUpperCase(), tid]);
  },
  getAllPromocodes: () => all('SELECT * FROM promocodes ORDER BY created_at DESC'),
  deletePromocode: code => run('DELETE FROM promocodes WHERE code=?', [code.toUpperCase()]),
  // ── SETTINGS
  getSetting: (key) => { const r = get('SELECT value FROM settings WHERE key=?', [key]); return r ? r.value : null; },
  setSetting: (key, value) => run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]),
  getAllSettings: () => {
    const rows = all('SELECT key, value FROM settings');
    const obj = {}; for (const r of rows) obj[r.key] = r.value; return obj;
  },
  // ── RECENT SERVERS
  upsertRecentServer: (tid, host, port, version) => {
    run('INSERT OR REPLACE INTO recent_servers (telegram_id, host, port, version, last_used) VALUES (?, ?, ?, ?, strftime(\'%s\',\'now\'))', [tid, host, port, version]);
    // Keep only last 5 per user
    const old = all('SELECT id FROM recent_servers WHERE telegram_id=? ORDER BY last_used DESC LIMIT -1 OFFSET 5', [tid]);
    for (const o of old) run('DELETE FROM recent_servers WHERE id=?', [o.id]);
  },
  getRecentServers: (tid) => all('SELECT * FROM recent_servers WHERE telegram_id=? ORDER BY last_used DESC LIMIT 5', [tid]),
};

// Peek next bot number without incrementing
module.exports.peekNextBotNumber = () => {
  const r = get('SELECT count FROM bot_counter WHERE id = 1');
  return r ? r.count + 1 : 1;
};

// ── MC ACCOUNTS (Premium) ──
// Каждый пользователь может сохранить несколько ников (до 5 на free, до 10 на premium)
// и выбирать нужный при подключении
module.exports.createAccount = (tid, nick) =>
  run('INSERT OR IGNORE INTO mc_accounts (telegram_id, nick) VALUES (?, ?)', [tid, nick]);

module.exports.getAccounts = (tid) =>
  all('SELECT * FROM mc_accounts WHERE telegram_id = ? ORDER BY last_used DESC', [tid]);

module.exports.deleteAccount = (id, tid) =>
  run('DELETE FROM mc_accounts WHERE id = ? AND telegram_id = ?', [id, tid]);

module.exports.touchAccount = (id) =>
  run('UPDATE mc_accounts SET last_used = strftime(\'%s\',\'now\') WHERE id = ?', [id]);

module.exports.getAccount = (id, tid) =>
  get('SELECT * FROM mc_accounts WHERE id = ? AND telegram_id = ?', [id, tid]);

// ── SAVED SERVERS ──
module.exports.getSavedServers = (tid) =>
  all('SELECT * FROM saved_servers WHERE telegram_id = ? ORDER BY created_at DESC', [tid]);

module.exports.addSavedServer = (tid, label, host, port, version) =>
  run('INSERT OR REPLACE INTO saved_servers (telegram_id, label, host, port, version) VALUES (?, ?, ?, ?, ?)',
    [tid, label, host, port, version]);

module.exports.deleteSavedServer = (id, tid) =>
  run('DELETE FROM saved_servers WHERE id = ? AND telegram_id = ?', [id, tid]);

module.exports.getSavedServer = (id, tid) =>
  get('SELECT * FROM saved_servers WHERE id = ? AND telegram_id = ?', [id, tid]);

// ── SESSIONS ──
module.exports.createSession = (tid, botUsername, host, port, version) => {
  const now = Math.floor(Date.now() / 1000);
  return run(
    'INSERT INTO sessions (telegram_id, bot_username, host, port, version, connected_at) VALUES (?, ?, ?, ?, ?, ?)',
    [tid, botUsername, host, port, version, now]
  ).lastInsertRowid;
};

module.exports.closeSession = (id, reason = 'manual') => {
  const now = Math.floor(Date.now() / 1000);
  const s = get('SELECT connected_at FROM sessions WHERE id = ?', [id]);
  const duration = s ? now - s.connected_at : 0;
  run('UPDATE sessions SET disconnected_at = ?, duration_seconds = ?, disconnect_reason = ? WHERE id = ?',
    [now, duration, reason, id]);
};

module.exports.getSessions = (tid, limit = 20) =>
  all('SELECT * FROM sessions WHERE telegram_id = ? ORDER BY connected_at DESC LIMIT ?', [tid, limit]);
