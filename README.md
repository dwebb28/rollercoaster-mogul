# 🎢 Rollercoaster Mogul

A browser-based theme park management game. Sign in with Google or GitHub, lay out paths, build rides and shops, hire staff, keep your guests happy, and compete for the most valuable park on the leaderboard.

## Gameplay

- **Paths:** click and drag from the entrance to lay walkways. Guests only walk on paths.
- **Rides:** 7 rides, from Whirly Teacups to the Comet Corkscrew coaster. Each has its own thrill, intensity, nausea, capacity and reliability. A ride needs a path tile next to it so guests can reach it.
- **Shops:** food, drinks and restrooms. Guests get hungry, thirsty and need the restroom, and they leave unhappy if they can't find what they need.
- **Scenery:** trees, flowers and fountains make nearby guests happier. Benches let tired guests rest. Litter bins cut down on litter.
- **Staff:** janitors sweep litter. Mechanics fix rides that break down.
- **Crime and security:** some visitors are criminals. Pickpockets steal guests' cash, brawlers assault guests, and robbers hit your shops' and rides' takings. On rare occasions an assault is fatal, which costs legal fees and drives witnesses out of the park. Crimes lower the park's **Safety** score, which hurts your rating and the number of new visitors. To fight back:
  - **Security guards** deter crime nearby, chase suspects and recover stolen money.
  - **Cameras** deter crime and identify culprits, who can be stopped at the gate.
  - **Lamp posts** cancel the higher crime rate at dusk.
  - **First aid posts** treat injured guests and make fatal assaults less likely.

  You can tune all of this in `CRIME` in `public/js/catalog.js`.
- **Economy:** you set the entrance fee and the price of every ride and shop. If prices are too high, guests refuse to pay. You pay staff wages and ride upkeep every day.
- **Guests:** each guest has their own thrill tolerance, budget and needs. Click a guest to see what they're thinking.
- **Goals and leaderboard:** complete milestones and rank by park value. Your park autosaves to your account.

**Controls:** right-drag, WASD or the arrow keys pan. Scroll or `+`/`-` zooms. `P` selects the path tool, `B` bulldoze, `R` rides, `F` shops, `T` scenery. `Space` pauses, `1`/`2`/`3` change speed, and `Esc` cancels.

## Running locally

Requires **Node.js 22.13+**. The app uses the built-in `node:sqlite`, so there are no native builds.

```bash
npm install
npm start          # http://localhost:3000
npm test           # simulation + API tests
```

Outside production, a **dev login** lets you play right away without any OAuth setup.

## Setting up social login

Copy `.env.example` to `.env` and fill in the providers you want. A provider is only shown when both its ID and secret are set.

| Provider | Where to create credentials | Callback URL |
| --- | --- | --- |
| Google | [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) (OAuth client ID, "Web application") | `${BASE_URL}/auth/google/callback` |
| GitHub | [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) | `${BASE_URL}/auth/github/callback` |

To add another provider such as Discord, register a Passport strategy in `server/auth.js` the same way.

### Production

Set `NODE_ENV=production`, a long random `SESSION_SECRET`, and `BASE_URL` set to your public HTTPS URL. In production, dev login is off, cookies are `Secure`, and the app trusts one reverse proxy hop. Keep `DATABASE_PATH` on persistent storage.

## Architecture

```
server/
  index.js          entry point
  app.js            Express app: security headers, sessions, API routes
  auth.js           Passport OAuth strategies (Google, GitHub) + dev login
  db.js             SQLite schema & queries (users, parks, sessions)
  session-store.js  express-session store on SQLite
public/
  index.html        landing page: sign-in + leaderboard
  game.html         the game
  js/catalog.js     rides, shops, scenery, staff, goals (all balancing lives here)
  js/sim.js         deterministic simulation; no DOM, shared with the server
  js/render.js      procedural isometric canvas renderer (no image assets)
  js/main.js        UI, input, game loop, autosave
tests/              node:test suites for the sim and the API
```

The simulation runs in the browser. On every save, the server parses the park with the same `sim.js` (`deserialize`), validating and clamping all values, and computes the leaderboard numbers from that parsed state. State-changing requests require a custom header as a CSRF defence.

**Known limitation:** because the sim runs on the client, a determined player could still edit their save before uploading it. A cheat-proof leaderboard would need the server to replay the player's build actions.
