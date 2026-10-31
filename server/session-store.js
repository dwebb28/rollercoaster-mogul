import session from 'express-session';

/** express-session store backed by the app's SQLite database. */
export class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs = 1000 * 60 * 60 * 24 * 30 } = {}) {
    super();
    this.q = db.sessions;
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.q.purgeSessions.run(Date.now()), 1000 * 60 * 15);
    this.timer.unref();
  }

  expiryFor(sess) {
    const exp = sess?.cookie?.expires;
    return exp ? new Date(exp).getTime() : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.q.getSession.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.q.setSession.run(sid, this.expiryFor(sess), JSON.stringify(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.q.touchSession.run(this.expiryFor(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.q.destroySession.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}
