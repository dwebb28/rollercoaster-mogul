// Regenerates docs/CUSTOMIZATION.md from the game's data tables, so the
// reference never drifts from the code. Run: npm run docs
import { writeFileSync } from 'node:fs';
import {
  SETTINGS_SCHEMA, DIFFICULTIES, CLIMATES, WEATHER, EVENTS, GUEST_TYPES, STAFF_TRAITS, PATH_STYLES, defaultSettings,
} from '../src/shared/options.ts';
import { RIDES, STALLS, SCENERY, STAFF, SPECIAL, AGEING, DESIGN_CODE_PREFIX, SHOP_VALUE } from '../src/shared/catalog.ts';
import { PIECES, PHYSICS } from '../src/shared/coaster.ts';

const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`),
].join('\n');
const pct = (w, total) => `${Math.round((w / total) * 100)}%`;
const range = (r) => (Array.isArray(r) ? `${r[0]}–${r[1]}` : r);
const money = (n) => `$${n.toLocaleString('en-US')}`;

const settingRows = SETTINGS_SCHEMA.map((s) => [
  `\`${s.key}\``, s.label, s.group, s.type === 'select' ? s.options.join(', ') : s.type === 'bool' ? 'on/off' : `${s.min}–${s.max}`,
  String(s.default), s.live ? 'yes' : 'no (set at creation)', s.help || '',
]);
const diffKeys = [...new Set(Object.values(DIFFICULTIES).flatMap((d) => Object.keys(d)).filter((k) => k !== 'label'))];
const diffRows = Object.keys(DIFFICULTIES).map((d) => { const s = defaultSettings(d); return [DIFFICULTIES[d].label, ...diffKeys.map((k) => String(s[k]))]; });
const climateRows = Object.entries(CLIMATES).map(([k, c]) => {
  const wt = Object.values(c.weather).reduce((a, b) => a + b, 0);
  const tt = Object.values(c.trees).reduce((a, b) => a + b, 0);
  return [`\`${k}\``, c.label, Object.entries(c.weather).map(([w, n]) => `${WEATHER[w].icon} ${w} ${pct(n, wt)}`).join(', '), Object.entries(c.trees).map(([t, n]) => `${t} ${pct(n, tt)}`).join(', ')];
});
const weatherRows = Object.entries(WEATHER).map(([k, w]) => [`${w.icon} \`${k}\``, `${w.arrivals}×`, `${w.thirst}×`, w.happyDrain ? `−${w.happyDrain}/s` : '—', `${w.breakdown}×`, [w.umbrella && 'umbrellas help', w.lightning && 'lightning strikes tall rides', w.fog && 'fog'].filter(Boolean).join(', ')]);
const ewt = EVENTS.reduce((a, e) => a + e.weight, 0);
const eventRows = EVENTS.map((e) => [`${e.icon} \`${e.id}\``, e.label, pct(e.weight, ewt), [e.crime && 'crime on', e.needsFallen && 'an officer has died', e.needsExecutions && 'executions have happened', e.needsWeather && `weather is ${e.needsWeather}`].filter(Boolean).join(', ') || 'always']);
const gwt = Object.values(GUEST_TYPES).reduce((a, g) => a + g.weight, 0);
const guestRows = Object.entries(GUEST_TYPES).map(([k, g]) => [`${g.icon} \`${k}\``, pct(g.weight, gwt), `$${range(g.cash)}`, range(g.pref), `${g.speed}×`, `${g.energy}×`, `${g.hunger}×`, g.litter, g.souvenir, [g.crime && `${g.crime}× crime`, g.influencer && 'posts a review on leaving'].filter(Boolean).join(', ')]);
const traitRows = Object.entries(STAFF_TRAITS).map(([k, t]) => [`${t.icon} \`${k}\``, t.label, t.roles ? t.roles.join(', ') : 'all', ['speed', 'wage', 'workSpeed'].filter((x) => t[x]).map((x) => `${x} ${t[x]}×`).concat(['hp', 'accuracy', 'deter'].filter((x) => t[x]).map((x) => `${x} ${t[x] > 0 ? '+' : ''}${t[x]}`)).join(', ')]);
const rideRows = Object.entries(RIDES).map(([k, r]) => [`\`${k}\``, r.name, `${r.w}×${r.h}`, money(r.cost), r.capacity, `${r.excitement}/${r.intensity}/${r.nausea}`, `$${r.price}`, `${money(r.upkeep)}/day`, `${((1 - r.reliability) * 100).toFixed(1)}%`]);
const stallRows = Object.entries(STALLS).map(([k, s]) => [`${s.icon} \`${k}\``, s.name, money(s.cost), s.sells, `$${s.price}`, `$${SHOP_VALUE[s.sells] ?? 2}`, `${money(s.upkeep)}/day`]);
const sceneryRows = Object.entries(SCENERY).map(([k, s]) => [`\`${k}\``, s.name, money(s.cost), s.beauty, [s.seat && 'seat', s.bin && 'litter bin', s.lamp && 'light', s.camera && 'camera', s.plant && 'plant'].filter(Boolean).join(', ')]);
const pieceRows = Object.entries(PIECES).map(([k, p]) => [`${p.icon} \`${k}\``, p.name, money(p.cost), p.len, p.dh ? `${p.dh > 0 ? '+' : ''}${p.dh} m` : '0', [p.turn && (p.wide ? 'wide turn (6 m radius)' : 'tight turn (2 m radius)'), p.chain && 'chain lift', p.boost && 'booster', p.brake && 'brakes / drive tyres', p.loop && 'vertical loop', p.station && 'station'].filter(Boolean).join(', ')]);

const md = `# Customization reference

> Generated from the game's data by \`npm run docs\` (scripts/gen-docs.mjs). Don't edit by hand: change
> \`src/shared/options.ts\`, \`src/shared/catalog.ts\` or \`src/shared/coaster.ts\` and regenerate.

Everything here is persisted with the park. How it's stored, validated and versioned is in
[PERSISTENCE.md](PERSISTENCE.md).

## Park settings

Chosen on the **Create your park** screen. Settings marked *live* can be changed mid-game from ⚙️ Rules.
They're stored in \`park.settings\` and read by the sim through \`park.settings.<key>\`.

${table(['Key', 'Label', 'Group', 'Values', 'Default', 'Live', 'Notes'], settingRows)}

### Difficulty presets

Picking a difficulty fills in these values (all others use the defaults above).

${table(['Preset', ...diffKeys], diffRows)}

## Climates

The climate sets the ground colour, the plants scattered on a new map, and the daily weather odds.

${table(['Key', 'Name', 'Weather odds', 'Starting plants'], climateRows)}

## Weather

Rolled each morning from the climate's odds. There's a 35% chance yesterday's weather carries over and a small
chance of a mid-day change. Turned off, the weather is always sunny.

${table(['Weather', 'Arrivals', 'Thirst', 'Happiness drain (outdoors)', 'Breakdowns', 'Other'], weatherRows)}

## Random events

Each morning (from day 2) there's a \`0.55 × eventRate\` chance of one event, picked by weight among the eligible ones.
Effects live in \`triggerEvent()\` in \`sim.js\`.

${table(['Event', 'Name', 'Share', 'Only when'], eventRows)}

**Buzz** (−100…+100) is word of mouth. Events and influencers move it. It adds \`buzz × 1.5\` to the rating target and
scales arrivals by \`1 + buzz/200\`. It decays slowly toward zero.

## Guest types

${table(['Type', 'Share', 'Cash', 'Thrill tolerance', 'Speed', 'Energy use', 'Hunger', 'Litter chance', 'Souvenir appetite', 'Special'], guestRows)}

## Staff traits

Each hire rolls 0 traits (40%), 1 (45%) or 2 (15%), never a clashing pair (speedy/lazy, sharpshooter/clumsy, tough/fragile,
veteran/rookie). Health and accuracy changes are applied at hire. Speed, wage and work speed apply continuously.

${table(['Trait', 'Name', 'Roles', 'Effect'], traitRows)}

Uniform colours per role are stored in \`park.uniforms\`.

## Rides

Thrill/Intensity/Nausea out of 10. Breakdown chance is per ride cycle before settings, weather and ageing.

${table(['Key', 'Name', 'Size', 'Cost', 'Riders', 'T/I/N', 'Price', 'Upkeep', 'Breakdown'], rideRows)}

**Ageing:** each day adds ${AGEING.perDay * 100}% breakdown chance (max +${AGEING.maxLoss * 100}%). Refurbishing costs ${AGEING.refurbishShare * 100}% of
what the ride cost and resets its age.

## Shops

"Worth" is what an average guest will pay before refusing, scaled by thrift (±25%) and the price-tolerance setting.

${table(['Shop', 'Name', 'Cost', 'Sells', 'Default price', 'Worth', 'Upkeep'], stallRows)}

## Scenery

${table(['Key', 'Name', 'Cost', 'Beauty', 'Role'], sceneryRows)}

## Special structures

${table(['Key', 'Name', 'Cost', 'Notes'], Object.entries(SPECIAL).map(([k, s]) => [`\`${k}\``, s.name, money(s.cost), s.auto ? 'placed automatically, cannot be built or removed' : `${money(s.upkeep)}/day upkeep`]))}

## Path styles

Stored per tile in \`park.pathStyles\` (one digit per tile). Laying a path uses the selected style; dragging over an
existing path repaints it for $2.

${table(['#', 'Style'], PATH_STYLES.map((p, i) => [i, p.label]))}

## Custom coasters

${table(['Piece', 'Name', 'Cost', 'Tiles', 'Height', 'Notes'], pieceRows)}

Physics constants: station ${PHYSICS.stationSpeed} m/s, chain ${PHYSICS.chainSpeed} m/s, booster +${PHYSICS.boostAccel} m/s per metre (max ${PHYSICS.boostMax} m/s),
brakes hold ${PHYSICS.brakeSpeed} m/s, loop radius ${PHYSICS.loopRadius * 4} m, banking up to ${Math.round(PHYSICS.maxBank * 180 / Math.PI)}°.

Cosmetics per coaster: track colour (\`color\`), train colour (\`trainColor\`), cars (\`cars\`, 2–7; capacity is 4 × cars), name.

### Design codes

A shareable coaster is \`${DESIGN_CODE_PREFIX}\` + base64(UTF-8 JSON):

\`\`\`json
{ "v": 1, "name": "Timber Tornado", "pieces": ["station", "straight", "lift", "…"], "cars": 4, "color": "#3a86ff", "trainColor": "#e5484d" }
\`\`\`

\`parseDesign()\` validates it: known pieces only, first piece a station, 2–400 pieces, colours as \`#rrggbb\`.
\`importDesign()\` places it piece by piece with the normal build rules and rolls back with a full refund if any piece is blocked.
Saved designs live in the browser (\`localStorage["rcm.designs"]\`) for now. See PERSISTENCE.md for the server table they should move to.

## Per-object cosmetics

Any ride, shop or scenery object may carry \`name\` (≤ 40 chars) and \`color\` (\`#rrggbb\`). Staff may be renamed.
`;

writeFileSync(new URL('../docs/CUSTOMIZATION.md', import.meta.url), md);
console.log('wrote docs/CUSTOMIZATION.md');
