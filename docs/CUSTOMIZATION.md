# Customization reference

> Generated from the game's data by `npm run docs` (scripts/gen-docs.mjs). Don't edit by hand: change
> `src/shared/options.ts`, `src/shared/catalog.ts` or `src/shared/coaster.ts` and regenerate.

Everything here is persisted with the park. How it's stored, validated and versioned is in
[PERSISTENCE.md](PERSISTENCE.md).

## Park settings

Chosen on the **Create your park** screen. Settings marked *live* can be changed mid-game from ⚙️ Rules.
They're stored in `park.settings` and read by the sim through `park.settings.<key>`.

| Key | Label | Group | Values | Default | Live | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `difficulty` | Difficulty | Park | sandbox, easy, normal, hard, nightmare | normal | no (set at creation) | Sets sensible defaults for everything below. You can still tweak each one. |
| `climate` | Climate | Park | temperate, desert, tropical, alpine, autumn | temperate | no (set at creation) | Changes the ground, the trees on the starting map and the weather you get. |
| `startCash` | Starting cash | Park | 0–10000000 | 25000 | no (set at creation) |  |
| `treeDensity` | Starting trees | Park | 0–3 | 1 | no (set at creation) | How wooded the starting map is. |
| `guestRate` | Guest arrivals | Guests | 0.25–3 | 1 | yes |  |
| `guestWealth` | Guest wealth | Guests | 0.25–3 | 1 | yes | How much money guests bring. |
| `priceTolerance` | Price tolerance | Guests | 0.5–2 | 1 | yes | How much guests are willing to pay before refusing. |
| `breakdowns` | Breakdowns | Operations | 0–3 | 1 | yes | Multiplies how often rides break down. 0 means never. |
| `ageing` | Ride ageing | Operations | on/off | true | yes | Rides get less reliable with age until refurbished. |
| `wages` | Staff wages | Operations | 0.5–2 | 1 | yes |  |
| `crimeRate` | Crime | Crime | 0–3 | 1 | yes | Multiplies how many visitors are criminals. 0 turns crime off. |
| `drugs` | Drugs & gangs | Crime | on/off | true | yes |  |
| `pandemonium` | Pandemonium raids | Crime | off, normal, aggressive | normal | yes |  |
| `officerDeaths` | Officers can die | Crime | on/off | true | yes |  |
| `executions` | Executions | Crime | on/off | true | yes | Allows the Retribution Rig and execution verdicts. |
| `gore` | Blood & gore | Crime | on/off | true | yes |  |
| `weather` | Weather | World | on/off | true | yes |  |
| `events` | Random events | World | on/off | true | yes |  |
| `eventRate` | Event frequency | World | 0.25–3 | 1 | yes |  |

### Difficulty presets

Picking a difficulty fills in these values (all others use the defaults above).

| Preset | startCash | crimeRate | pandemonium | breakdowns | guestWealth | wages | priceTolerance | guestRate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sandbox | 1000000 | 0 | off | 0.5 | 1.5 | 0.5 | 1.3 | 1 |
| Easy | 60000 | 0.5 | normal | 0.75 | 1.25 | 1 | 1.15 | 1 |
| Normal | 25000 | 1 | normal | 1 | 1 | 1 | 1 | 1 |
| Hard | 15000 | 1.5 | aggressive | 1.5 | 0.85 | 1.25 | 0.85 | 1 |
| Nightmare | 8000 | 2.5 | aggressive | 2.5 | 0.7 | 1.5 | 0.7 | 0.75 |

## Climates

The climate sets the ground colour, the plants scattered on a new map, and the daily weather odds.

| Key | Name | Weather odds | Starting plants |
| --- | --- | --- | --- |
| `temperate` | Temperate | ☀️ sunny 37%, ⛅ cloudy 28%, 🌧️ rain 19%, ⛈️ storm 5%, 🔥 heatwave 5%, 🌫️ fog 7% | tree 50%, pine 40%, cherry 10% |
| `desert` | Desert | ☀️ sunny 58%, 🔥 heatwave 29%, ⛅ cloudy 10%, ⛈️ storm 3% | cactus 50%, palm 25%, rock 25% |
| `tropical` | Tropical | ☀️ sunny 39%, 🌧️ rain 29%, ⛈️ storm 12%, 🔥 heatwave 10%, ⛅ cloudy 10% | palm 78%, tree 22% |
| `alpine` | Alpine | ⛅ cloudy 30%, 🌨️ snow 30%, ☀️ sunny 20%, 🌫️ fog 15%, ⛈️ storm 5% | pine 78%, rock 19%, snowman 3% |
| `autumn` | Autumn | ⛅ cloudy 36%, 🌧️ rain 27%, ☀️ sunny 18%, 🌫️ fog 14%, ⛈️ storm 5% | tree 67%, pine 22%, cherry 11% |

## Weather

Rolled each morning from the climate's odds. There's a 35% chance yesterday's weather carries over and a small
chance of a mid-day change. Turned off, the weather is always sunny.

| Weather | Arrivals | Thirst | Happiness drain (outdoors) | Breakdowns | Other |
| --- | --- | --- | --- | --- | --- |
| ☀️ `sunny` | 1× | 1× | — | 1× |  |
| ⛅ `cloudy` | 0.95× | 0.9× | — | 1× |  |
| 🌧️ `rain` | 0.6× | 0.7× | −0.15/s | 1.2× | umbrellas help |
| ⛈️ `storm` | 0.35× | 0.7× | −0.3/s | 3× | umbrellas help, lightning strikes tall rides |
| 🔥 `heatwave` | 0.9× | 1.8× | −0.05/s | 1.3× |  |
| 🌨️ `snow` | 0.6× | 0.6× | −0.1/s | 1.4× | umbrellas help |
| 🌫️ `fog` | 0.85× | 0.9× | −0.02/s | 1× | fog |

## Random events

Each morning (from day 2) there's a `0.55 × eventRate` chance of one event, picked by weight among the eligible ones.
Effects live in `triggerEvent()` in `sim.js`.

| Event | Name | Share | Only when |
| --- | --- | --- | --- |
| 🚌 `tourBus` | Tour bus | 20% | always |
| 🤝 `sponsor` | Sponsorship deal | 10% | always |
| 🕴️ `vip` | VIP visit | 8% | always |
| 📋 `inspector` | Health inspector | 10% | always |
| 🔌 `powerOutage` | Power outage | 7% | always |
| 📱 `viral` | Viral post | 10% | always |
| 🎟️ `lottery` | Lottery winner | 7% | always |
| ⭐ `celebrity` | Celebrity sighting | 5% | always |
| 👛 `pickpocketRing` | Pickpocket ring | 7% | crime on |
| 💐 `donation` | Memorial donation | 7% | an officer has died |
| 🪧 `protest` | Protest | 7% | executions have happened |
| 🍦 `heatAdvisory` | Ice cream rush | 5% | weather is heatwave |

**Buzz** (−100…+100) is word of mouth. Events and influencers move it. It adds `buzz × 1.5` to the rating target and
scales arrivals by `1 + buzz/200`. It decays slowly toward zero.

## Guest types

| Type | Share | Cash | Thrill tolerance | Speed | Energy use | Hunger | Litter chance | Souvenir appetite | Special |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 👨‍👩‍👧 `family` | 32% | $30–90 | 1–5 | 0.9× | 1.1× | 1.1× | 0.7 | 0.3 |  |
| 🤘 `thrill` | 24% | $40–120 | 6–10 | 1.1× | 0.9× | 1× | 0.75 | 0.1 |  |
| 🛹 `teen` | 16% | $15–55 | 4–9 | 1.2× | 0.8× | 1.3× | 0.95 | 0.15 | 1.5× crime |
| 👴 `senior` | 12% | $50–150 | 1–3 | 0.65× | 1.5× | 0.8× | 0.4 | 0.4 |  |
| 📸 `tourist` | 12% | $80–220 | 2–7 | 0.9× | 1× | 1× | 0.6 | 0.8 |  |
| 🤳 `influencer` | 3% | $60–160 | 3–8 | 1× | 1× | 0.9× | 0.6 | 0.5 | posts a review on leaving |

## Staff traits

Each hire rolls 0 traits (40%), 1 (45%) or 2 (15%), never a clashing pair (speedy/lazy, sharpshooter/clumsy, tough/fragile,
veteran/rookie). Health and accuracy changes are applied at hire. Speed, wage and work speed apply continuously.

| Trait | Name | Roles | Effect |
| --- | --- | --- | --- |
| 💨 `speedy` | Speedy | all | speed 1.3× |
| 😴 `lazy` | Lazy | all | speed 0.75×, wage 0.85× |
| 🎯 `sharpshooter` | Sharpshooter | squad | accuracy +0.1 |
| 🙃 `clumsy` | Clumsy | squad | accuracy -0.1 |
| 💪 `tough` | Tough | all | hp +2 |
| 🩹 `fragile` | Fragile | all | hp -1 |
| 🦅 `eagleEye` | Eagle-eyed | guard | deter +2 |
| 🎖️ `veteran` | Veteran | all | wage 1.25×, hp +1, accuracy +0.05 |
| 🐣 `rookie` | Rookie | all | wage 0.8×, accuracy -0.05 |
| 🧽 `meticulous` | Meticulous | janitor, mechanic | speed 0.9×, workSpeed 1.5× |

Uniform colours per role are stored in `park.uniforms`.

## Rides

Thrill/Intensity/Nausea out of 10. Breakdown chance is per ride cycle before settings, weather and ageing.

| Key | Name | Size | Cost | Riders | T/I/N | Price | Upkeep | Breakdown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `teacups` | Whirly Teacups | 2×2 | $1,200 | 8 | 3/2/4 | $2 | $15/day | 1.5% |
| `carousel` | Gallop Carousel | 2×2 | $1,500 | 10 | 3/1/1 | $2 | $15/day | 1.0% |
| `skywheel` | Sky Wheel | 3×3 | $2,800 | 12 | 4/1/1 | $3 | $25/day | 1.5% |
| `bumper` | Bumper Bash | 3×2 | $3,200 | 10 | 5/3/2 | $3 | $30/day | 2.5% |
| `droptower` | Plummet Tower | 2×2 | $4,500 | 8 | 6/8/5 | $4 | $40/day | 3.0% |
| `woodie` | Timber Rattler | 5×3 | $9,000 | 16 | 8/6/4 | $6 | $70/day | 3.5% |
| `looper` | Comet Corkscrew | 6×4 | $16,000 | 20 | 9/9/7 | $8 | $110/day | 4.0% |
| `chairswing` | Sky Swinger | 2×2 | $2,600 | 12 | 5/4/4 | $3 | $25/day | 2.0% |
| `pirateship` | Buccaneer Swing | 3×2 | $3,800 | 20 | 5/5/6 | $3 | $30/day | 2.0% |

**Ageing:** each day adds 0.12% breakdown chance (max +6%). Refurbishing costs 30% of
what the ride cost and resets its age.

## Shops

"Worth" is what an average guest will pay before refusing, scaled by thrift (±25%) and the price-tolerance setting.

| Shop | Name | Cost | Sells | Default price | Worth | Upkeep |
| --- | --- | --- | --- | --- | --- | --- |
| 🍔 `burger` | Burger Shack | $400 | food | $4 | $7 | $10/day |
| 🍕 `pizza` | Pizza Slice | $500 | food | $5 | $7 | $12/day |
| 🍋 `lemonade` | Lemonade Stand | $300 | drink | $2 | $4.5 | $8/day |
| 🥤 `soda` | Fizz Pop | $350 | drink | $3 | $4.5 | $8/day |
| 🚻 `restroom` | Restrooms | $600 | restroom | $0 | $2 | $12/day |
| ⛑️ `firstaid` | First Aid Post | $700 | firstaid | $0 | $2 | $20/day |
| 🍦 `icecream` | Ice Cream Cart | $450 | food | $3 | $7 | $9/day |
| ☕ `coffee` | Coffee Kiosk | $500 | drink | $3 | $4.5 | $9/day |
| 🎁 `souvenir` | Souvenir Shop | $900 | souvenir | $8 | $12 | $15/day |
| ☂️ `umbrella` | Umbrella Stand | $400 | umbrella | $6 | $9 | $8/day |
| 🏧 `atm` | Cash Machine | $1,200 | atm | $2 | $3 | $10/day |
| ℹ️ `info` | Information Kiosk | $600 | info | $1 | $2 | $10/day |

## Scenery

| Key | Name | Cost | Beauty | Role |
| --- | --- | --- | --- | --- |
| `tree` | Oak Tree | $25 | 2 | plant |
| `pine` | Pine Tree | $25 | 2 | plant |
| `flowers` | Flower Bed | $15 | 3 | plant |
| `fountain` | Fountain | $400 | 10 |  |
| `bench` | Bench | $50 | 0 | seat |
| `bin` | Litter Bin | $40 | 0 | litter bin |
| `lamp` | Lamp Post | $60 | 1 | light |
| `camera` | Security Camera | $300 | 0 | camera |
| `palm` | Palm Tree | $40 | 3 | plant |
| `cactus` | Cactus | $30 | 2 | plant |
| `cherry` | Cherry Blossom | $60 | 4 | plant |
| `hedge` | Hedge | $30 | 2 | plant |
| `rock` | Boulder | $30 | 1 |  |
| `statue` | Statue | $350 | 6 |  |
| `snowman` | Snowman | $40 | 3 |  |

## Special structures

| Key | Name | Cost | Notes |
| --- | --- | --- | --- |
| `securityhq` | Security HQ | $5,000 | $60/day upkeep |
| `retribution` | Retribution Rig | $12,000 | $40/day upkeep |
| `memorial` | Fallen Officers Memorial | $0 | placed automatically, cannot be built or removed |

## Path styles

Stored per tile in `park.pathStyles` (one digit per tile). Laying a path uses the selected style; dragging over an
existing path repaints it for $2.

| # | Style |
| --- | --- |
| 0 | Sandstone |
| 1 | Concrete |
| 2 | Red brick |
| 3 | Boardwalk |
| 4 | Cobblestone |
| 5 | Tarmac |

## Custom coasters

| Piece | Name | Cost | Tiles | Height | Notes |
| --- | --- | --- | --- | --- | --- |
| 🚉 `station` | Station | $300 | 1 | 0 | station |
| ⬆ `straight` | Straight | $60 | 1 | 0 |  |
| ↰ `left` | Tight left | $90 | 1 | 0 | tight turn (2 m radius) |
| ↱ `right` | Tight right | $90 | 1 | 0 | tight turn (2 m radius) |
| ⮪ `wideLeft` | Wide left | $200 | 1 | 0 | wide turn (6 m radius) |
| ⮫ `wideRight` | Wide right | $200 | 1 | 0 | wide turn (6 m radius) |
| ↗ `up` | Slope up | $80 | 1 | +1 m |  |
| ↘ `down` | Slope down | $80 | 1 | -1 m |  |
| ⤴ `steepUp` | Steep climb | $110 | 1 | +3 m |  |
| ⤵ `steepDown` | Steep drop | $110 | 1 | -3 m |  |
| ⛓ `lift` | Chain lift | $200 | 1 | +2 m | chain lift |
| ⚡ `booster` | Launch booster | $450 | 1 | 0 | booster |
| ⏸ `brake` | Brakes | $150 | 1 | 0 | brakes / drive tyres |
| ➰ `loop` | Vertical loop | $900 | 4 | 0 | vertical loop |

Physics constants: station 2 m/s, chain 4 m/s, booster +1.2 m/s per metre (max 32 m/s),
brakes hold 5 m/s, loop radius 8 m, banking up to 60°.

Cosmetics per coaster: track colour (`color`), train colour (`trainColor`), cars (`cars`, 2–7; capacity is 4 × cars), name.

### Design codes

A shareable coaster is `RCM1:` + base64(UTF-8 JSON):

```json
{ "v": 1, "name": "Timber Tornado", "pieces": ["station", "straight", "lift", "…"], "cars": 4, "color": "#3a86ff", "trainColor": "#e5484d" }
```

`parseDesign()` validates it: known pieces only, first piece a station, 2–400 pieces, colours as `#rrggbb`.
`importDesign()` places it piece by piece with the normal build rules and rolls back with a full refund if any piece is blocked.
Saved designs live in the browser (`localStorage["rcm.designs"]`) for now. See PERSISTENCE.md for the server table they should move to.

## Per-object cosmetics

Any ride, shop or scenery object may carry `name` (≤ 40 chars) and `color` (`#rrggbb`). Staff may be renamed.
