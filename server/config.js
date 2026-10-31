import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function loadConfig(env = process.env) {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');

  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT) || 3000;
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (production) throw new Error('SESSION_SECRET must be set in production');
    sessionSecret = randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET not set; using a random one (sessions reset on restart).');
  }

  return {
    production,
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    sessionSecret,
    databasePath: env.DATABASE_PATH || 'data/mogul.db',
    devLogin: env.ENABLE_DEV_LOGIN ? env.ENABLE_DEV_LOGIN === 'true' : !production,
    google: { clientID: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    github: { clientID: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
  };
}
