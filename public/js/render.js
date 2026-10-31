// Isometric canvas renderer. Everything is drawn procedurally — no image assets.

import { GRID, RIDES, STALLS, STAFF } from './catalog.js';
import { TILE, ENTRANCE, idx, actorPos, objectAt } from './sim.js';

export const TW = 64; // tile width in world pixels
export const TH = 32; // tile height in world pixels
const SKIN = ['#f4d1b5', '#e0ac85', '#c68863', '#8d5a3b', '#5c3a24'];

/** Tile-space point -> world pixel point (before camera transform). */
const P = (fx, fy, h = 0) => ({ x: (fx - fy) * (TW / 2), y: (fx + fy) * (TH / 2) - h });

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => clampByte(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
const hash = (n) => {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.zoom = 1;
    this.camX = 0; // screen-space offset (CSS px) of world origin
    this.camY = 0;
    this.floaters = [];
    this.resize();
    this.centerOn(ENTRANCE.x, ENTRANCE.y - 8);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  centerOn(fx, fy) {
    const p = P(fx, fy);
    this.camX = this.canvas.clientWidth / 2 - p.x * this.zoom;
    this.camY = this.canvas.clientHeight / 2 - p.y * this.zoom;
  }

  pan(dx, dy) {
    this.camX += dx;
    this.camY += dy;
  }

  zoomAt(factor, sx, sy) {
    const z = Math.max(0.35, Math.min(2.5, this.zoom * factor));
    const wx = (sx - this.camX) / this.zoom;
    const wy = (sy - this.camY) / this.zoom;
    this.zoom = z;
    this.camX = sx - wx * z;
    this.camY = sy - wy * z;
  }

  /** CSS-pixel screen point -> continuous tile coordinates. */
  screenToTile(sx, sy) {
    const wx = (sx - this.camX) / this.zoom / (TW / 2);
    const wy = (sy - this.camY) / this.zoom / (TH / 2);
    return { x: (wx + wy) / 2, y: (wy - wx) / 2 };
  }

  floatText(fx, fy, text, color) {
    this.floaters.push({ fx, fy, text, color, age: 0 });
  }

  render(park, view, dt) {
    const { ctx } = this;
    const t = view.time;
    this.dusk = view.dayProgress > 0.75 ? Math.sin(((view.dayProgress - 0.75) / 0.25) * Math.PI) : 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2f5d3a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr * this.zoom, 0, 0, this.dpr * this.zoom, this.dpr * this.camX, this.dpr * this.camY);

    this.drawGround(park);

    const drawables = [];
    for (const o of park.objects) drawables.push({ d: o.x + o.w + o.y + o.h - 1, o });
    drawables.push({ d: ENTRANCE.x + ENTRANCE.y + 1, entrance: true });
    for (const g of park.guests) {
      if (g.state === 'ride') continue;
      const p = actorPos(g);
      drawables.push({ d: p.x + p.y + 0.01, g, p });
    }
    for (const s of park.staff) {
      const p = actorPos(s);
      drawables.push({ d: p.x + p.y + 0.01, s, p });
    }
    drawables.sort((a, b) => a.d - b.d);

    for (const it of drawables) {
      if (it.o) this.drawObject(it.o, t, view.selected === it.o.id);
      else if (it.g) this.drawGuest(it.g, it.p, t, view.selected === it.g.id);
      else if (it.s) this.drawStaff(it.s, it.p, t, view.selected === it.s.id);
      else this.drawEntrance(park);
    }

    this.drawOverlay(park, view);
    this.drawFloaters(dt);

    // Dusk tint toward the end of each day.
    if (view.dayProgress > 0.75) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const a = this.dusk * 0.22;
      ctx.fillStyle = `rgba(40, 30, 90, ${a})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  diamond(fx, fy, w = 1, h = 1, lift = 0) {
    const { ctx } = this;
    const a = P(fx, fy, lift), b = P(fx + w, fy, lift), c = P(fx + w, fy + h, lift), d = P(fx, fy + h, lift);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }

  /** Isometric box with its footprint at (fx,fy,w,h) rising `height` px. */
  box(fx, fy, w, h, height, color, base = 0) {
    const { ctx } = this;
    const l = P(fx, fy + h, base), bt = P(fx + w, fy + h, base), r = P(fx + w, fy, base);
    ctx.fillStyle = shade(color, -0.25);
    ctx.beginPath();
    ctx.moveTo(l.x, l.y); ctx.lineTo(bt.x, bt.y); ctx.lineTo(bt.x, bt.y - height); ctx.lineTo(l.x, l.y - height);
    ctx.fill();
    ctx.fillStyle = shade(color, -0.4);
    ctx.beginPath();
    ctx.moveTo(bt.x, bt.y); ctx.lineTo(r.x, r.y); ctx.lineTo(r.x, r.y - height); ctx.lineTo(bt.x, bt.y - height);
    ctx.fill();
    this.diamond(fx, fy, w, h, base + height);
    ctx.fillStyle = color;
    ctx.fill();
  }

  drawGround(park) {
    const { ctx } = this;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = idx(x, y);
        const tile = park.tiles[i];
        this.diamond(x, y);
        if (tile === TILE.GRASS) {
          ctx.fillStyle = (x + y) % 2 ? '#6fbf5a' : '#69b755';
          ctx.fill();
        } else {
          ctx.fillStyle = '#9c8a6e';
          ctx.fill();
          this.diamond(x + 0.06, y + 0.06, 0.88, 0.88);
          ctx.fillStyle = tile === TILE.ENTRANCE ? '#d9b26a' : '#d7c4a3';
          ctx.fill();
          const litter = park.litter[i];
          for (let k = 0; k < litter; k++) {
            const p = P(x + 0.2 + hash(i * 7 + k) * 0.6, y + 0.2 + hash(i * 13 + k) * 0.6);
            ctx.fillStyle = k % 2 ? '#f4f4f4' : '#d6463c';
            ctx.fillRect(p.x - 1.5, p.y - 1, 3, 2);
          }
        }
      }
    }
    // Park edge.
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    this.diamond(0, 0, GRID, GRID);
    ctx.stroke();
  }

  drawEntrance(park) {
    const { ctx } = this;
    const { x, y } = ENTRANCE;
    const l = P(x, y + 0.5), r = P(x + 1, y + 0.5);
    ctx.fillStyle = '#7a4b2a';
    ctx.fillRect(l.x - 3, l.y - 46, 6, 46);
    ctx.fillRect(r.x - 3, r.y - 46, 6, 46);
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.moveTo(l.x - 8, l.y - 44);
    ctx.lineTo(r.x + 8, r.y - 44);
    ctx.lineTo(r.x + 8, r.y - 58);
    ctx.lineTo(l.x - 8, l.y - 58);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 8px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const c = P(x + 0.5, y + 0.5);
    ctx.fillText(park.open ? 'WELCOME' : 'CLOSED', c.x, c.y - 48);
  }

  drawObject(o, t, selected) {
    const { ctx } = this;
    if (selected) {
      this.diamond(o.x, o.y, o.w, o.h);
      ctx.fillStyle = 'rgba(255, 230, 80, 0.35)';
      ctx.fill();
    }
    const ride = RIDES[o.kind];
    if (ride) this.drawRide(o, ride, t);
    else if (STALLS[o.kind]) this.drawStall(o, STALLS[o.kind]);
    else this.drawScenery(o, t);

    if (ride || STALLS[o.kind]) {
      const c = P(o.x + o.w / 2, o.y + o.h / 2);
      const top = c.y - (ride ? 30 + o.h * 18 : 52);
      if (o.broken) this.badge(c.x, top, '#e5484d', '!');
      else if (!o.open) this.badge(c.x, top, '#555', '×');
    }
  }

  badge(x, y, color, text) {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 1);
    ctx.textBaseline = 'alphabetic';
  }

  drawRide(o, def, t) {
    const { ctx } = this;
    const running = o.phase === 'running';
    const progress = running ? 1 - o.timer / def.duration : 0;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const c = P(cx, cy);
    const spin = running ? t : 0;

    switch (o.kind) {
      case 'teacups': {
        this.box(o.x + 0.1, o.y + 0.1, o.w - 0.2, o.h - 0.2, 5, '#f7d6e6');
        const cups = ['#ef6fa8', '#5aa9e6', '#f2b84b', '#7bd389'];
        const items = cups.map((col, k) => {
          const a = spin * 1.6 + (k * Math.PI) / 2;
          return { col, a, x: c.x + Math.cos(a) * 22, y: c.y - 5 + Math.sin(a) * 11 };
        }).sort((p, q) => p.y - q.y);
        for (const cup of items) {
          ctx.fillStyle = shade(cup.col, -0.3);
          ctx.beginPath(); ctx.ellipse(cup.x, cup.y - 3, 9, 6, 0, 0, Math.PI); ctx.fill();
          ctx.fillStyle = cup.col;
          ctx.beginPath(); ctx.ellipse(cup.x, cup.y - 6, 9, 4.5, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.2)';
          ctx.beginPath(); ctx.ellipse(cup.x, cup.y - 6, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case 'carousel': {
        this.box(o.x + 0.1, o.y + 0.1, o.w - 0.2, o.h - 0.2, 6, '#f6e3b4');
        for (let k = 0; k < 6; k++) {
          const a = spin * 1.2 + (k * Math.PI) / 3;
          const px = c.x + Math.cos(a) * 20, py = c.y - 6 + Math.sin(a) * 10;
          ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 30); ctx.stroke();
          ctx.fillStyle = k % 2 ? '#fff' : '#8b5a2b';
          ctx.fillRect(px - 5, py - 12 - Math.sin(t * 4 + k) * (running ? 3 : 0), 10, 5);
        }
        ctx.fillStyle = '#e5484d';
        ctx.beginPath();
        ctx.ellipse(c.x, c.y - 36, 30, 13, 0, 0, Math.PI);
        ctx.lineTo(c.x, c.y - 62);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fff';
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI + 0.3;
          ctx.beginPath();
          ctx.moveTo(c.x, c.y - 62);
          ctx.lineTo(c.x + Math.cos(a) * 30, c.y - 36 + Math.sin(a) * 13);
          ctx.lineTo(c.x + Math.cos(a + 0.35) * 30, c.y - 36 + Math.sin(a + 0.35) * 13);
          ctx.fill();
        }
        break;
      }
      case 'skywheel': {
        this.box(o.x + 0.3, o.y + 0.3, o.w - 0.6, o.h - 0.6, 6, '#c9d6e3');
        const wy = c.y - 78, R = 62;
        ctx.strokeStyle = '#5b6b7a'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(c.x - 30, c.y - 2); ctx.lineTo(c.x, wy); ctx.lineTo(c.x + 30, c.y - 2); ctx.stroke();
        const rot = spin * 0.35;
        ctx.strokeStyle = def.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(c.x, wy, R, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1;
        for (let k = 0; k < 12; k++) {
          const a = rot + (k * Math.PI) / 6;
          ctx.beginPath(); ctx.moveTo(c.x, wy); ctx.lineTo(c.x + Math.cos(a) * R, wy + Math.sin(a) * R); ctx.stroke();
        }
        const cabins = ['#e5484d', '#f2b84b', '#7bd389', '#9b6bd6', '#ef6fa8', '#ffffff'];
        for (let k = 0; k < 12; k++) {
          const a = rot + (k * Math.PI) / 6;
          const px = c.x + Math.cos(a) * R, py = wy + Math.sin(a) * R;
          ctx.fillStyle = cabins[k % cabins.length];
          ctx.fillRect(px - 5, py, 10, 9);
        }
        ctx.fillStyle = '#333';
        ctx.beginPath(); ctx.arc(c.x, wy, 5, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'bumper': {
        this.box(o.x + 0.05, o.y + 0.05, o.w - 0.1, o.h - 0.1, 8, '#3b4a5a');
        this.diamond(o.x + 0.25, o.y + 0.25, o.w - 0.5, o.h - 0.5, 8);
        ctx.fillStyle = '#26323e'; ctx.fill();
        const colors = ['#e5484d', '#f2b84b', '#5aa9e6', '#7bd389', '#ef6fa8'];
        for (let k = 0; k < 5; k++) {
          const a = spin * (0.8 + k * 0.23) + k * 1.7;
          const p = P(cx + Math.cos(a) * (o.w / 2 - 0.55), cy + Math.sin(a * 1.3) * (o.h / 2 - 0.55), 8);
          ctx.fillStyle = colors[k];
          ctx.beginPath(); ctx.ellipse(p.x, p.y - 3, 7, 4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#999'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p.x, p.y - 3); ctx.lineTo(p.x, p.y - 16); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(200,200,200,0.5)'; ctx.lineWidth = 1;
        for (let k = 0; k < 4; k++) {
          const a = P(o.x + 0.1, o.y + 0.1 + (k * (o.h - 0.2)) / 3, 24);
          const b = P(o.x + o.w - 0.1, o.y + 0.1 + (k * (o.h - 0.2)) / 3, 24);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        break;
      }
      case 'droptower': {
        this.box(o.x + 0.15, o.y + 0.15, o.w - 0.3, o.h - 0.3, 6, '#d9cdf0');
        this.box(cx - 0.18, cy - 0.18, 0.36, 0.36, 160, '#9aa4b0', 6);
        let h = 14;
        if (running) {
          if (progress < 0.55) h = 14 + (progress / 0.55) * 128;
          else if (progress < 0.7) h = 142;
          else if (progress < 0.78) h = 142 - ((progress - 0.7) / 0.08) * 128;
          else h = 14;
        }
        this.box(cx - 0.4, cy - 0.4, 0.8, 0.8, 12, def.color, h);
        ctx.fillStyle = '#e5484d';
        const top = P(cx, cy, 170);
        ctx.beginPath(); ctx.arc(top.x, top.y, 3, 0, Math.PI * 2); ctx.fill();
        break;
      }
      default:
        if (def.coaster) this.drawCoaster(o, def, t, running, progress);
    }
  }

  drawCoaster(o, def, t, running, progress) {
    const { ctx } = this;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const rx = o.w / 2 - 0.45, ry = o.h / 2 - 0.45;
    const lift = def.loop ? 46 : 34;
    const track = (th) => {
      const h = 16 + (1 + Math.sin(th * 2 + 0.6)) * lift * (def.loop ? 1 : 0.8) + Math.max(0, Math.sin(th)) * 14;
      return { ...P(cx + Math.cos(th) * rx, cy + Math.sin(th) * ry, h), g: P(cx + Math.cos(th) * rx, cy + Math.sin(th) * ry), th };
    };
    const N = 72;
    const pts = [];
    for (let k = 0; k <= N; k++) pts.push(track((k / N) * Math.PI * 2));

    // Station platform along the front edge.
    this.box(o.x + 0.2, o.y + o.h - 0.9, Math.min(2, o.w - 0.4), 0.7, 8, '#b9a27f');
    const wood = def.loop ? '#8b98a6' : '#8a5a33';
    ctx.strokeStyle = wood; ctx.lineWidth = def.loop ? 2 : 1.5;
    for (let k = 0; k < N; k += def.loop ? 4 : 2) {
      const p = pts[k];
      ctx.beginPath(); ctx.moveTo(p.g.x, p.g.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      if (!def.loop && k % 4 === 0) {
        ctx.beginPath(); ctx.moveTo(p.g.x - 4, p.g.y); ctx.lineTo(p.x + 4, p.y + 6); ctx.stroke();
      }
    }
    const rail = (off, col, w) => {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.beginPath();
      pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y + off) : ctx.moveTo(p.x, p.y + off)));
      ctx.stroke();
    };
    rail(2, shade(def.color, -0.35), 3);
    rail(0, def.color, 2.5);

    if (def.loop) {
      const p = pts[Math.round(N * 0.1)];
      ctx.strokeStyle = def.color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y - 26, 26, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#8b98a6'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.g.x, p.g.y); ctx.stroke();
    }

    // Train: parked at the station when idle, racing around when running.
    const cars = 4;
    const base = running ? Math.PI * 0.5 + progress * Math.PI * 4 : Math.PI * 0.5;
    for (let k = cars - 1; k >= 0; k--) {
      const p = track(base - k * 0.22);
      ctx.fillStyle = k === 0 ? '#ffd23f' : '#ffffff';
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(p.x - 5, p.y - 7, 10, 6); ctx.fill(); ctx.stroke();
    }
  }

  drawStall(o, def) {
    const { ctx } = this;
    const restroom = def.sells === 'restroom';
    this.box(o.x + 0.15, o.y + 0.15, 0.7, 0.7, 20, restroom ? '#cfd8e0' : '#f4efe6');
    // Striped awning on the front faces.
    const l = P(o.x + 0.1, o.y + 0.9, 22), b = P(o.x + 0.9, o.y + 0.9, 22), r = P(o.x + 0.9, o.y + 0.1, 22);
    for (let k = 0; k < 6; k++) {
      ctx.fillStyle = k % 2 ? '#fff' : def.color;
      const s = (from, to, a0, a1) => {
        const x0 = from.x + (to.x - from.x) * a0, y0 = from.y + (to.y - from.y) * a0;
        const x1 = from.x + (to.x - from.x) * a1, y1 = from.y + (to.y - from.y) * a1;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 + 6); ctx.lineTo(x0, y0 + 6); ctx.fill();
      };
      s(l, b, k / 6, (k + 1) / 6);
      s(b, r, k / 6, (k + 1) / 6);
    }
    this.diamond(o.x + 0.1, o.y + 0.1, 0.8, 0.8, 26);
    ctx.fillStyle = def.color; ctx.fill();
    const c = P(o.x + 0.5, o.y + 0.5, 36);
    ctx.font = '15px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(def.icon, c.x, c.y);
  }

  drawScenery(o, t) {
    const { ctx } = this;
    const c = P(o.x + 0.5, o.y + 0.5);
    const r = hash(o.id);
    switch (o.kind) {
      case 'tree': {
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.beginPath(); ctx.ellipse(c.x, c.y, 14, 7, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#6b4423'; ctx.fillRect(c.x - 2.5, c.y - 18, 5, 18);
        const s = 0.85 + r * 0.35;
        for (const [dx, dy, rr, col] of [[0, -30, 14, '#2f7d32'], [-7, -24, 10, '#3a8f3c'], [7, -25, 10, '#358a37'], [2, -36, 9, '#45a047']]) {
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(c.x + dx * s, c.y + dy * s, rr * s, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case 'pine': {
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.beginPath(); ctx.ellipse(c.x, c.y, 11, 5.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#5a3a1e'; ctx.fillRect(c.x - 2, c.y - 10, 4, 10);
        const s = 0.85 + r * 0.4;
        for (let k = 0; k < 3; k++) {
          ctx.fillStyle = k % 2 ? '#2b6b3a' : '#24603a';
          ctx.beginPath();
          ctx.moveTo(c.x, c.y - (30 + k * 12) * s);
          ctx.lineTo(c.x + (13 - k * 3) * s, c.y - (8 + k * 12) * s);
          ctx.lineTo(c.x - (13 - k * 3) * s, c.y - (8 + k * 12) * s);
          ctx.fill();
        }
        break;
      }
      case 'flowers': {
        this.diamond(o.x + 0.12, o.y + 0.12, 0.76, 0.76);
        ctx.fillStyle = '#5a3f2b'; ctx.fill();
        const cols = ['#ff5d8f', '#ffd23f', '#ffffff', '#b07cff', '#ff8a3d'];
        for (let k = 0; k < 14; k++) {
          const p = P(o.x + 0.2 + hash(o.id * 31 + k) * 0.6, o.y + 0.2 + hash(o.id * 17 + k) * 0.6);
          ctx.fillStyle = '#2e7d32'; ctx.fillRect(p.x - 0.5, p.y - 4, 1, 4);
          ctx.fillStyle = cols[k % cols.length];
          ctx.beginPath(); ctx.arc(p.x, p.y - 4, 2, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case 'fountain': {
        const fc = P(o.x + 1, o.y + 1);
        ctx.fillStyle = '#b8b2a7';
        ctx.beginPath(); ctx.ellipse(fc.x, fc.y, 44, 22, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#4fa3d9';
        ctx.beginPath(); ctx.ellipse(fc.x, fc.y - 3, 38, 18, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#9b9488'; ctx.fillRect(fc.x - 4, fc.y - 22, 8, 20);
        ctx.fillStyle = 'rgba(200,235,255,0.85)';
        for (let k = 0; k < 10; k++) {
          const ph = (t * 1.5 + k / 10) % 1;
          const a = (k / 10) * Math.PI * 2;
          const px = fc.x + Math.cos(a) * ph * 26, py = fc.y - 24 + Math.sin(a) * ph * 12 - Math.sin(ph * Math.PI) * 18 + ph * 20;
          ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case 'bench': {
        this.box(o.x + 0.25, o.y + 0.4, 0.5, 0.2, 6, '#8b5a2b');
        this.box(o.x + 0.25, o.y + 0.35, 0.5, 0.06, 14, '#7a4b22');
        break;
      }
      case 'bin': {
        ctx.fillStyle = '#2d5a3d';
        ctx.fillRect(c.x - 5, c.y - 14, 10, 13);
        ctx.fillStyle = '#3d7a52';
        ctx.beginPath(); ctx.ellipse(c.x, c.y - 14, 5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1e3d2a';
        ctx.beginPath(); ctx.ellipse(c.x, c.y - 1, 5, 2.5, 0, 0, Math.PI); ctx.fill();
        break;
      }
      case 'lamp': {
        ctx.fillStyle = '#2f3540';
        ctx.fillRect(c.x - 1.5, c.y - 34, 3, 34);
        ctx.fillRect(c.x - 4, c.y - 2, 8, 2);
        if (this.dusk > 0) {
          const glow = ctx.createRadialGradient(c.x, c.y - 36, 2, c.x, c.y - 30, 40);
          glow.addColorStop(0, `rgba(255, 225, 140, ${0.55 * this.dusk})`);
          glow.addColorStop(1, 'rgba(255, 225, 140, 0)');
          ctx.fillStyle = glow;
          ctx.beginPath(); ctx.ellipse(c.x, c.y - 10, 44, 30, 0, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = this.dusk > 0 ? '#ffe9a0' : '#f4f1e6';
        ctx.beginPath(); ctx.arc(c.x, c.y - 37, 4, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'camera': {
        ctx.fillStyle = '#5c6470';
        ctx.fillRect(c.x - 1.5, c.y - 30, 3, 30);
        ctx.fillStyle = '#e8ecf0';
        ctx.save();
        ctx.translate(c.x, c.y - 31);
        ctx.rotate(Math.sin(t * 0.8 + o.id) * 0.5);
        ctx.fillRect(-2, -4, 12, 7);
        ctx.fillStyle = '#20252b';
        ctx.fillRect(9, -3, 3, 5);
        ctx.restore();
        ctx.fillStyle = Math.floor(t * 2) % 2 ? '#ff3b30' : '#7a1d18';
        ctx.beginPath(); ctx.arc(c.x + 1, c.y - 35, 1.5, 0, Math.PI * 2); ctx.fill();
        break;
      }
      default:
        this.box(o.x + 0.2, o.y + 0.2, 0.6, 0.6, 10, '#999');
    }
  }

  person(p, color, t, id, { sitting = false, hat = null, selected = false } = {}) {
    const { ctx } = this;
    const s = P(p.x, p.y);
    const bob = sitting ? 0 : Math.abs(Math.sin(t * 9 + id)) * 1.2;
    if (selected) {
      ctx.strokeStyle = '#ffe24d'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(s.x, s.y, 8, 4, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath(); ctx.ellipse(s.x, s.y, 4.5, 2.2, 0, 0, Math.PI * 2); ctx.fill();
    const y0 = s.y - bob - (sitting ? -3 : 0);
    ctx.fillStyle = '#2c3440';
    if (!sitting) {
      ctx.fillRect(s.x - 2.5, y0 - 6, 2, 6);
      ctx.fillRect(s.x + 0.5, y0 - 6, 2, 6);
    }
    ctx.fillStyle = color;
    ctx.fillRect(s.x - 3, y0 - 13, 6, 7);
    ctx.fillStyle = SKIN[id % SKIN.length];
    ctx.beginPath(); ctx.arc(s.x, y0 - 16, 3, 0, Math.PI * 2); ctx.fill();
    if (hat) { ctx.fillStyle = hat; ctx.fillRect(s.x - 3.5, y0 - 20, 7, 2.5); }
  }

  drawGuest(g, p, t, selected) {
    let pos = p;
    if (g.state === 'queue') {
      // Fan queued guests out around their tile so the line is visible.
      const a = hash(g.id) * Math.PI * 2;
      pos = { x: p.x + Math.cos(a) * 0.3, y: p.y + Math.sin(a) * 0.3 };
    }
    this.person(pos, g.shirt, g.state === 'walk' ? t : 0, g.id, { sitting: g.state === 'sit', selected });
    const s = P(pos.x, pos.y);
    const { ctx } = this;
    if (g.crime && g.spotted) {
      // Identified suspect: red marker overhead.
      ctx.fillStyle = '#e5484d';
      ctx.beginPath(); ctx.moveTo(s.x - 4, s.y - 30); ctx.lineTo(s.x + 4, s.y - 30); ctx.lineTo(s.x, s.y - 24); ctx.fill();
    } else if (g.injured) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(s.x - 4, s.y - 31, 8, 8);
      ctx.fillStyle = '#e5484d';
      ctx.fillRect(s.x - 1, s.y - 30, 2, 6);
      ctx.fillRect(s.x - 3, s.y - 28, 6, 2);
    }
  }

  drawStaff(s, p, t, selected) {
    const col = STAFF[s.role].color;
    this.person(p, col, s.busy > 0 ? 0 : t, s.id, { hat: shade(col, -0.35), selected });
  }

  drawOverlay(park, view) {
    const { ctx } = this;
    const h = view.hover;
    if (!h) return;
    if (view.ghost) {
      const { x, y, w, hgt, ok } = view.ghost;
      for (let yy = y; yy < y + hgt; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          this.diamond(xx, yy);
          ctx.fillStyle = ok ? 'rgba(80, 220, 120, 0.45)' : 'rgba(240, 70, 70, 0.45)';
          ctx.fill();
        }
      }
      this.diamond(x, y, w, hgt);
      ctx.strokeStyle = ok ? '#2ecc71' : '#e74c3c';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (view.tool === 'bulldoze') {
      const o = objectAt(park, h.x, h.y);
      if (o) this.diamond(o.x, o.y, o.w, o.h);
      else this.diamond(h.x, h.y);
      ctx.fillStyle = 'rgba(240, 70, 70, 0.35)';
      ctx.fill();
    } else {
      this.diamond(h.x, h.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  drawFloaters(dt) {
    const { ctx } = this;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    this.floaters = this.floaters.filter((f) => (f.age += dt) < 1.6);
    for (const f of this.floaters) {
      const p = P(f.fx, f.fy, 30 + f.age * 30);
      ctx.globalAlpha = 1 - f.age / 1.6;
      ctx.fillStyle = '#000';
      ctx.fillText(f.text, p.x + 1, p.y + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }
}

