import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import * as Sim from '../public/js/sim.js';

let server, base;
const H = { 'X-Requested-With': 'rollercoaster-mogul', 'Content-Type': 'application/json' };

before(async () => {
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test-secret', DATABASE_PATH: ':memory:' });
  const app = createApp(config);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  server.on('close', app.locals.close);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function login(name) {
  const res = await fetch(`${base}/auth/dev`, { method: 'POST', headers: H, body: JSON.stringify({ name }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

test('lists providers and enables dev login outside production', async () => {
  const body = await (await fetch(`${base}/auth/providers`)).json();
  assert.deepEqual(body, { providers: [], devLogin: true });
});

test('API requires a session', async () => {
  assert.equal((await fetch(`${base}/api/me`)).status, 401);
  assert.equal((await fetch(`${base}/api/park`)).status, 401);
});

test('state-changing requests need the CSRF header', async () => {
  const res = await fetch(`${base}/auth/dev`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(res.status, 403);
});

test('save, load, and rank a park', async () => {
  const cookie = await login('Alice');
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.displayName, 'Alice');
  assert.equal((await fetch(`${base}/api/park`, { headers: { cookie } })).status, 404);

  const park = Sim.createPark("Alice's Park", 4);
  const save = await fetch(`${base}/api/park`, {
    method: 'PUT', headers: { ...H, cookie }, body: JSON.stringify(Sim.serialize(park)),
  });
  assert.equal(save.status, 200);

  const loaded = Sim.deserialize(await (await fetch(`${base}/api/park`, { headers: { cookie } })).json());
  assert.equal(loaded.name, "Alice's Park");

  const { parks } = await (await fetch(`${base}/api/leaderboard`)).json();
  assert.equal(parks[0].park, "Alice's Park");
  assert.equal(parks[0].owner, 'Alice');
  assert.equal(parks[0].value, Sim.parkSummary(park).value);
});

test('rejects invalid park data', async () => {
  const cookie = await login('Mallory');
  const res = await fetch(`${base}/api/park`, {
    method: 'PUT', headers: { ...H, cookie }, body: JSON.stringify({ version: 1, tiles: 'nope' }),
  });
  assert.equal(res.status, 400);
});

test('logout ends the session', async () => {
  const cookie = await login('Bob');
  await fetch(`${base}/auth/logout`, { method: 'POST', headers: { ...H, cookie } });
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
});

test('the server stores the canonical, validated save', async () => {
  const cookie = await login('Casey');
  const data = Sim.serialize(Sim.createPark('Canon', 8));
  data.junk = '<script>alert(1)</script>';
  data.cash = 1e15; // clamped on the way in
  data.settings.crimeRate = 99;
  await fetch(`${base}/api/park`, { method: 'PUT', headers: { ...H, cookie }, body: JSON.stringify(data) });
  const stored = await (await fetch(`${base}/api/park`, { headers: { cookie } })).json();
  assert.equal(stored.junk, undefined);
  assert.equal(stored.cash, 1e10);
  assert.equal(stored.settings.crimeRate, 3);
  assert.equal(stored.version, Sim.SAVE_VERSION);
});
