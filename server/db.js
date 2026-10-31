import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      provider     TEXT NOT NULL,
      provider_id  TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url   TEXT,
      created_at   INTEGER NOT NULL,
      last_login   INTEGER NOT NULL,
      UNIQUE (provider, provider_id)
    );

    CREATE TABLE IF NOT EXISTS parks (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      data        TEXT NOT NULL,
      value       INTEGER NOT NULL DEFAULT 0,
      rating      INTEGER NOT NULL DEFAULT 0,
      guests      INTEGER NOT NULL DEFAULT 0,
      day         INTEGER NOT NULL DEFAULT 1,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      expires INTEGER NOT NULL,
      data    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
  `);

  const q = {
    findUser: db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?'),
    getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (provider, provider_id, display_name, avatar_url, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    touchUser: db.prepare('UPDATE users SET display_name = ?, avatar_url = ?, last_login = ? WHERE id = ?'),
    getPark: db.prepare('SELECT * FROM parks WHERE user_id = ?'),
    upsertPark: db.prepare(`
      INSERT INTO parks (user_id, name, data, value, rating, guests, day, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        name = excluded.name, data = excluded.data, value = excluded.value,
        rating = excluded.rating, guests = excluded.guests, day = excluded.day,
        updated_at = excluded.updated_at
    `),
    deletePark: db.prepare('DELETE FROM parks WHERE user_id = ?'),
    leaderboard: db.prepare(`
      SELECT p.name AS park, p.value, p.rating, p.guests, p.day,
             u.display_name AS owner, u.avatar_url AS avatar
      FROM parks p JOIN users u ON u.id = p.user_id
      ORDER BY p.value DESC LIMIT ?
    `),
    getSession: db.prepare('SELECT data, expires FROM sessions WHERE sid = ?'),
    setSession: db.prepare(`
      INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data
    `),
    touchSession: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
    destroySession: db.prepare('DELETE FROM sessions WHERE sid = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires < ?'),
  };

  return {
    raw: db,
    upsertOAuthUser({ provider, providerId, displayName, avatarUrl }) {
      const now = Date.now();
      const name = String(displayName || 'Park Owner').slice(0, 60);
      const avatar = avatarUrl ? String(avatarUrl).slice(0, 500) : null;
      const existing = q.findUser.get(provider, String(providerId));
      if (existing) {
        q.touchUser.run(name, avatar, now, existing.id);
        return q.getUser.get(existing.id);
      }
      const { lastInsertRowid } = q.insertUser.run(provider, String(providerId), name, avatar, now, now);
      return q.getUser.get(Number(lastInsertRowid));
    },
    getUser: (id) => q.getUser.get(id),
    getPark: (userId) => q.getPark.get(userId),
    savePark(userId, { name, data, value, rating, guests, day }) {
      q.upsertPark.run(userId, name, data, value, rating, guests, day, Date.now());
    },
    deletePark: (userId) => q.deletePark.run(userId),
    leaderboard: (limit = 20) => q.leaderboard.all(limit),
    sessions: q,
    close: () => db.close(),
  };
}
