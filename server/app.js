import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './db.js';
import { SqliteSessionStore } from './session-store.js';
import { setupAuth } from './auth.js';
import { deserialize, parkSummary } from '../public/js/sim.js';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_PARK_BYTES = 2 * 1024 * 1024;

export function createApp(config) {
  const db = openDatabase(config.databasePath);
  const store = new SqliteSessionStore(db);
  const app = express();

  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  app.use(express.json({ limit: MAX_PARK_BYTES }));
  app.use(
    session({
      name: 'rcm.sid',
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        maxAge: 1000 * 60 * 60 * 24 * 30,
      },
    })
  );

  // CSRF defence: state-changing requests must carry a custom header, which
  // browsers will not send cross-origin without a CORS preflight we never allow.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Requested-With') !== 'rollercoaster-mogul') {
      return res.status(403).json({ error: 'Missing request header' });
    }
    next();
  });

  app.use('/auth', setupAuth(app, db, config));

  const api = express.Router();
  const requireUser = (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: 'Not signed in' });

  api.get('/me', requireUser, (req, res) => {
    const { id, display_name, avatar_url, provider } = req.user;
    res.json({ id, displayName: display_name, avatarUrl: avatar_url, provider });
  });

  api.get('/park', requireUser, (req, res) => {
    const row = db.getPark(req.user.id);
    if (!row) return res.status(404).json({ error: 'No park yet' });
    res.type('application/json').send(row.data);
  });

  api.put('/park', requireUser, (req, res) => {
    let park;
    try {
      park = deserialize(req.body);
    } catch (err) {
      return res.status(400).json({ error: `Invalid park data: ${err.message}` });
    }
    const summary = parkSummary(park);
    db.savePark(req.user.id, {
      name: summary.name,
      data: JSON.stringify(req.body),
      value: summary.value,
      rating: summary.rating,
      guests: summary.guests,
      day: summary.day,
    });
    res.json({ ok: true, savedAt: Date.now() });
  });

  api.delete('/park', requireUser, (req, res) => {
    db.deletePark(req.user.id);
    res.json({ ok: true });
  });

  api.get('/leaderboard', (_req, res) => {
    res.json({ parks: db.leaderboard(20) });
  });

  app.use('/api', api);
  app.use(express.static(join(here, '..', 'public'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: config.production ? 'Server error' : err.message });
  });

  app.locals.close = () => {
    store.close();
    db.close();
  };
  return app;
}
