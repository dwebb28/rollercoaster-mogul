# 🎢 Rollercoaster Mogul

A browser-based 3D theme park management game. Sign in with Google or GitHub, lay out paths, build rides and shops, hire staff, keep your guests happy, and compete for the most valuable park on the leaderboard.

## Gameplay

**Every park is customizable.** The *Create your park* screen offers:

- difficulty presets: Sandbox, Easy, Normal, Hard, Nightmare
- a map seed
- a climate: temperate, desert, tropical, alpine or autumn
- starting cash and trees
- guest arrivals, wealth and price tolerance
- breakdowns, ride ageing and wages
- crime, drugs, Pandemonium (off, normal or aggressive), officer deaths, executions, and blood & gore
- weather, and random events and how often they happen

Most of these can be changed mid-game from ⚙️ **Rules**. The full reference is in [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md).

- **Paths:** click and drag from the entrance to lay walkways. Guests only walk on paths.
- **Rides:** 7 rides, from Whirly Teacups to the Comet Corkscrew coaster. Each has its own thrill, intensity, nausea, capacity and reliability. A ride needs a path tile next to it so guests can reach it.
- **Custom coasters:** choose 🎢 Rides → 🛠️ Design your own coaster, place a station, and lay track piece by piece. Pieces include straights, tight and wide turns, slopes, chain lifts, launch boosters, brakes and vertical loops.
  - A physics model runs the train around the circuit, accounting for gravity, drag, rolling resistance, banking in turns, and vertical and lateral G-forces.
  - The test run fails if the train stalls on a hill or can't get round a loop.
  - Speed, G-forces, airtime, drops and inversions set the ride's excitement, intensity and nausea, which decide who will ride it and what they'll pay.
- **Shops:** food, drinks and restrooms. Guests get hungry, thirsty and need the restroom, and they leave unhappy if they can't find what they need.
- **Scenery:** trees, flowers and fountains make nearby guests happier. Benches let tired guests rest. Litter bins cut down on litter.
- **Staff:** janitors sweep litter. Mechanics fix rides that break down.
- **Crime and security:** some visitors are criminals. Pickpockets steal guests' cash, brawlers assault guests, and robbers hit your shops' and rides' takings. On rare occasions an assault is fatal, which costs legal fees and drives witnesses out of the park. Crimes lower the park's **Safety** score, which hurts your rating and the number of new visitors. To fight back:
  - **Security guards** deter crime nearby, chase suspects and recover stolen money.
  - **Cameras** deter crime and identify culprits, who can be stopped at the gate.
  - **Lamp posts** cancel the higher crime rate at dusk.
  - **First aid posts** treat injured guests and make fatal assaults less likely.

  Violence leaves blood on the paths, which upsets guests until janitors scrub it away.

  You can tune all of this in `CRIME` in `public/js/catalog.js`.
- **Pandemonium:** pandas throw bamboo back at security. On average they're weaker than an officer: less health, worse aim, slower throws. Officers who run out of health are knocked out for a while. A heist crew in panda costumes raids the park from day 4. Members appear at random spots across the park, rob tills, smash rides and shops, and beat up guests. After a while they run for the exit with the loot, and each raid brings a bigger crew. To fight them:
  - Build a **Security HQ** (🛡️ Security menu, or `G`).
  - Hire **Hot Dog Squad** officers. They hunt the pandas with hot dog launchers, and each panda goes down after 4 hits.
  - If you capture the whole crew, use the **Retribution Rig** to stage a public execution. A catapult hurls the prisoners at full speed into a fire pit, or into a dunk tank where they drown. Spectators pay to watch, every guest gets a big happiness boost, and Safety is fully restored.

- **Fallen officers:** when pandas knock out an officer, there's a 25% chance the officer is killed instead.
  - The park pays life insurance to the family: $5,000 per squad officer and $3,000 per guard.
  - The fallen are buried in a mass grave inside the park, under a **Fallen Officers Memorial**. It's placed automatically beside a path near the entrance, gains a headstone for each death, and can't be bulldozed.

  You can tune all of this in `PANDEMONIUM` in `public/js/catalog.js`.
- **Suspects and sentencing:** every criminal keeps a record: thefts, assaults, robberies, drug deals, killings, money stolen and gang. Click an identified suspect to see their record, or open the 🚨 **Wanted** list to see every known suspect at large and gang activity. Everyone apprehended, pandas included, goes into custody, and you're asked to:
  - **Release** them, which costs some Safety.
  - **Fine** them. The fine grows with their record, and they're banned from the park.
  - **Execute** them on the Retribution Rig by fire pit or drowning.
- **Drugs and gangs:** about 4% of visitors are drug dealers, and about 1 in 5 food and drink vendors secretly deals under the counter.
  - Guests who buy get high. They wander in a daze and can't find the exit.
  - When the high wears off, about 30% join a crime gang and start committing crimes themselves.
  - Guards and cameras can expose a corrupt vendor. You can replace the vendor from the shop's panel.
- **Barbed wire perimeter:** costs $15,000 plus upkeep. Once it's up you can lock the exits at any time. Nobody gets in or out, criminals and Pandemonium included, but trapped guests get angry and your rating drops.
- **Weather and events:** each climate rolls its own daily weather, from sun and fog to rain, snow, heatwaves and lightning storms. Weather changes arrivals, thirst, happiness and breakdowns.
  - Most days bring a random event, such as a tour bus, sponsor, VIP, health inspector, power outage, viral post, lottery winner, celebrity, pickpocket ring, memorial donation or protest.
  - **Buzz** (word of mouth) moves your rating and visitor numbers.
- **Guest types:** families, thrill-seekers, teenagers, seniors, tourists and influencers, each with their own budget, thrill tolerance, pace, appetite, litter habits and taste for souvenirs. Influencers post a review when they leave.
- **Staff traits:** hires can be Speedy, Lazy, Tough, Fragile, Sharpshooter, Clumsy, Eagle-eyed, Veteran, Rookie or Meticulous. Traits change speed, health, aim, wages and work speed.
- **Customization:**
  - Rename and repaint any ride, shop or statue, and choose staff uniform colours.
  - Pick from 6 path styles.
  - Custom coasters take a track colour, train colour and 2–7 cars, and can be shared as `RCM1:` design codes and saved to a personal library.
  - Rides age and can be refurbished.
- **More to build:** chair swings, a pirate ship, an ice cream cart, coffee kiosk, souvenir shop, umbrella stand, cash machine and information kiosk, plus palms, cacti, cherry blossoms, hedges, boulders, statues and snowmen.
- **Economy:** you set the entrance fee and the price of every ride and shop. If prices are too high, guests refuse to pay. You pay staff wages and ride upkeep every day.
- **Guests:** each guest has their own thrill tolerance, budget and needs. Click a guest to see what they're thinking.
- **💡 Tips:** the in-game Tips panel explains every system, from coaster physics to sentencing, insurance and lockdown.
- **Goals and leaderboard:** complete milestones and rank by park value. Your park autosaves to your account.

**Controls:** right-drag, WASD or the arrow keys pan. `Q`/`E` or middle-drag rotate the camera, and middle-drag also tilts it. Scroll or `+`/`-` zooms. `P` selects the path tool, `B` bulldoze, `R` rides, `F` shops, `T` scenery, `G` security. `Space` pauses, `1`/`2`/`3` change speed, and `Esc` cancels.

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
  js/options.js     settings schema, difficulty presets, climates, weather, events, guest types, staff traits, path styles
  js/sim.js         deterministic simulation; no DOM, shared with the server
  js/render3d.js    Three.js WebGL renderer: lighting, shadows, instanced crowds, coaster track
  js/render.js      2D isometric canvas fallback when WebGL is unavailable
  js/coaster.js     custom coaster track layout and train physics (shared with the server)
  js/main.js        UI, input, game loop, autosave
tests/              node:test suites for the sim, coasters, customization and the API
docs/
  PERSISTENCE.md    save format, validation, versioning and the proposed production schema
  CUSTOMIZATION.md  every option and content table (generated: npm run docs)
scripts/gen-docs.mjs
```

Saves are versioned JSON documents (currently v2, with v1 migrated automatically). See [docs/PERSISTENCE.md](docs/PERSISTENCE.md) for the full format and the plan for production infrastructure.

The simulation runs in the browser. On every save, the server parses the park with the same `sim.js` (`deserialize`), validating and clamping all values, and computes the leaderboard numbers from that parsed state. State-changing requests require a custom header as a CSRF defence.

**Known limitation:** because the sim runs on the client, a determined player could still edit their save before uploading it. A cheat-proof leaderboard would need the server to replay the player's build actions.
