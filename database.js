const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'scanner.db');
const db = new Database(dbPath, { verbose: console.log });

db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    game TEXT NOT NULL,
    label TEXT,
    createdBy TEXT,
    createdAt TEXT,
    expiresAt TEXT,
    active INTEGER DEFAULT 1,
    maxUses INTEGER DEFAULT 1,
    currentUses INTEGER DEFAULT 0,
    notes TEXT,
    imageUrl TEXT,
    discord_id TEXT,
    email TEXT,
    role TEXT DEFAULT 'member',
    password TEXT,
    social_link TEXT,
    social_links TEXT DEFAULT '[]',
    badges TEXT DEFAULT '[]',
    profile_effect TEXT DEFAULT 'none',
    profile_theme TEXT DEFAULT 'default',
    profile_overlay_url TEXT
  );

  CREATE TABLE IF NOT EXISTS custom_strings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    string TEXT NOT NULL,
    process TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: Add role, password, and social_link columns if they don't exist
try {
  db.prepare("ALTER TABLE keys ADD COLUMN role TEXT DEFAULT 'member'").run();
} catch (err) {}
try {
  db.prepare("ALTER TABLE keys ADD COLUMN password TEXT").run();
} catch (err) {}
try {
  db.prepare("ALTER TABLE keys ADD COLUMN social_link TEXT").run();
} catch (err) {}
try {
  db.prepare("ALTER TABLE keys ADD COLUMN social_links TEXT DEFAULT '[]'").run();
} catch (err) {}
try {
  db.prepare("ALTER TABLE keys ADD COLUMN badges TEXT DEFAULT '[]'").run();
} catch (err) {}
try {
  db.prepare("ALTER TABLE keys ADD COLUMN profile_effect TEXT DEFAULT 'none'").run();
} catch (err) {}
try {
  db.prepare("ALTER TABLE keys ADD COLUMN profile_theme TEXT DEFAULT 'default'").run();
} catch (err) {}
try {
  db.prepare("ALTER TABLE keys ADD COLUMN profile_overlay_url TEXT").run();
} catch (err) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    discord TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    message_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scans (
    scan_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL, -- The key id
    game TEXT NOT NULL,
    results_json TEXT,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    FOREIGN KEY (id) REFERENCES keys (id)
  );

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    leader_username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    username TEXT NOT NULL UNIQUE,
    role TEXT DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    discord_id TEXT,
    email TEXT,
    FOREIGN KEY (team_id) REFERENCES teams (id)
  );

  CREATE TABLE IF NOT EXISTS referrals (
    code TEXT PRIMARY KEY,
    team_id INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    is_used INTEGER DEFAULT 0,
    used_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams (id)
  );

  CREATE TABLE IF NOT EXISTS false_positives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT,
    user_id TEXT,
    file_path TEXT NOT NULL,
    finding_id TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    reviewed_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS whitelist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL UNIQUE,
    added_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_username TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    message TEXT,
    attachment_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_custom_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    role_name TEXT NOT NULL,
    role_color TEXT DEFAULT '#ffffff',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE
  );
`);

try {
  db.exec(`ALTER TABLE applications ADD COLUMN message_id TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE keys ADD COLUMN discord_id TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE keys ADD COLUMN email TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE team_members ADD COLUMN discord_id TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE team_members ADD COLUMN email TEXT;`);
} catch (e) {}

try {
  db.exec(`ALTER TABLE false_positives ADD COLUMN full_data TEXT;`);
} catch (e) {}

// New migrations
try { db.exec(`ALTER TABLE keys ADD COLUMN avatar_url TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE keys ADD COLUMN banner_url TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE keys ADD COLUMN bio TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE keys ADD COLUMN profile_color TEXT DEFAULT '#10b981';`); } catch (e) {}

try { db.exec(`ALTER TABLE teams ADD COLUMN logo_url TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE teams ADD COLUMN description TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE teams ADD COLUMN color TEXT DEFAULT '#10b981';`); } catch (e) {}

try { db.exec(`ALTER TABLE team_members ADD COLUMN custom_role TEXT;`); } catch (e) {}

module.exports = db;
