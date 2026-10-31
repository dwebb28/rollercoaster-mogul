import { Router } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';

/**
 * Registers whichever OAuth providers have credentials configured and
 * returns a router mounted at /auth.
 */
export function setupAuth(app, db, config) {
  const enabled = [];

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    try {
      done(null, db.getUser(id) || false);
    } catch (err) {
      done(err);
    }
  });

  const verify = (provider) => (_accessToken, _refreshToken, profile, done) => {
    try {
      const user = db.upsertOAuthUser({
        provider,
        providerId: profile.id,
        displayName: profile.displayName || profile.username,
        avatarUrl: profile.photos?.[0]?.value,
      });
      done(null, user);
    } catch (err) {
      done(err);
    }
  };

  if (config.google.clientID && config.google.clientSecret) {
    passport.use(
      new GoogleStrategy(
        { ...config.google, callbackURL: `${config.baseUrl}/auth/google/callback` },
        verify('google')
      )
    );
    enabled.push({ id: 'google', name: 'Google', scope: ['profile'] });
  }

  if (config.github.clientID && config.github.clientSecret) {
    passport.use(
      new GitHubStrategy(
        { ...config.github, callbackURL: `${config.baseUrl}/auth/github/callback` },
        verify('github')
      )
    );
    enabled.push({ id: 'github', name: 'GitHub', scope: ['read:user'] });
  }

  app.use(passport.initialize());
  app.use(passport.session());

  const router = Router();

  router.get('/providers', (_req, res) => {
    res.json({
      providers: enabled.map(({ id, name }) => ({ id, name, url: `/auth/${id}` })),
      devLogin: config.devLogin,
    });
  });

  for (const { id, scope } of enabled) {
    router.get(`/${id}`, passport.authenticate(id, { scope }));
    router.get(
      `/${id}/callback`,
      passport.authenticate(id, { failureRedirect: '/?error=login_failed' }),
      (_req, res) => res.redirect('/game.html')
    );
  }

  if (config.devLogin) {
    // Local development only: sign in as a named test user without OAuth.
    router.post('/dev', (req, res, next) => {
      const name = String(req.body?.name || '').trim().slice(0, 40);
      if (!name) return res.status(400).json({ error: 'Name required' });
      const user = db.upsertOAuthUser({ provider: 'dev', providerId: name.toLowerCase(), displayName: name });
      req.login(user, (err) => (err ? next(err) : res.json({ ok: true })));
    });
  }

  router.post('/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => {
        res.clearCookie('rcm.sid');
        res.json({ ok: true });
      });
    });
  });

  return router;
}
