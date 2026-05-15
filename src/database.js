const Database = require('better-sqlite3');
const path      = require('path');

const fs = require('fs');
const dbDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data')
    : path.join(__dirname, '../data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, 'nostalgia.db'));

// Activer WAL pour de meilleures performances
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── TABLES ────────────────────────────────────────────────────
db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
        id            TEXT PRIMARY KEY,
        prenom        TEXT NOT NULL,
        nom           TEXT NOT NULL,
        email         TEXT NOT NULL,
        phone         TEXT NOT NULL,
        category      TEXT NOT NULL CHECK(category IN ('CLASSIC','VIP')),
        qty           INTEGER NOT NULL DEFAULT 1,
        unit_price    INTEGER NOT NULL,
        total_price   INTEGER NOT NULL,
        payment_method TEXT NOT NULL CHECK(payment_method IN ('MTN','ORANGE')),
        payment_phone TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','refunded')),
        payment_ref   TEXT,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        paid_at       DATETIME
    );

    CREATE TABLE IF NOT EXISTS tickets (
        id            TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL REFERENCES orders(id),
        prenom        TEXT NOT NULL,
        nom           TEXT NOT NULL,
        category      TEXT NOT NULL,
        is_used       INTEGER NOT NULL DEFAULT 0,
        used_at       DATETIME,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scan_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id  TEXT NOT NULL,
        result     TEXT NOT NULL CHECK(result IN ('valid','already_used','invalid')),
        scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        scanner_ip TEXT
    );

    CREATE TABLE IF NOT EXISTS payment_verifications (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id    TEXT NOT NULL,
        result      TEXT NOT NULL DEFAULT 'pending',
        ai_reason   TEXT,
        attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

module.exports = db;
