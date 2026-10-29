'use strict';

const crypto = require('crypto');

const MIN = 60 * 1000;
const MAX_PLAYERS = 30;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const DEFAULT_SETTINGS = {
  city: null, // { name, lat, lng }
  radius: 5000, // mètres
  headStartMin: 10,
  pingEveryMin: 5,
  hidersSeeHiders: true,
};

class GameError extends Error {}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const isLat = (v) => typeof v === 'number' && v >= -90 && v <= 90;
const isLng = (v) => typeof v === 'number' && v >= -180 && v <= 180;

function toInt(v, min, max, label) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new GameError(`Valeur invalide : ${label}.`);
  return clamp(n, min, max);
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function makeCode(taken) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!taken.has(code)) return code;
  }
}

class Room {
  constructor(code, now = Date.now()) {
    this.code = code;
    this.createdAt = now;
    this.lastActive = now;
    this.status = 'lobby'; // lobby | running | ended
    this.round = 0; // nombre de manches lancées
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = new Map();
    this.hostId = null;
    this.startedAt = null;
    this.releaseAt = null; // fin de l'avance : les hunters partent
    this.nextPingAt = null;
    this.endedAt = null;
    this.pings = new Map(); // id du hider -> dernier ping partagé
    this.conns = new Map(); // id -> websocket (géré par le transport)
  }

  addPlayer(name, now = Date.now()) {
    if (this.status !== 'lobby') throw new GameError('La partie a déjà commencé.');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('Le salon est plein.');
    const clean = cleanName(name);
    if (!clean) throw new GameError('Entrez un pseudo.');
    const lower = clean.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) throw new GameError('Ce pseudo est déjà pris.');
    }
    const player = {
      id: crypto.randomBytes(4).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name: clean,
      role: null, // 'hider' | 'hunter'
      caught: false,
      caughtAt: null,
      left: false,
      online: false,
      live: null, // dernière position GPS reçue, jamais diffusée telle quelle
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.lastActive = now;
    return player;
  }

  findByToken(token) {
    if (typeof token !== 'string') return null;
    for (const p of this.players.values()) if (p.token === token && !p.left) return p;
    return null;
  }

  removePlayer(id, now = Date.now()) {
    const p = this.players.get(id);
    if (!p) return;
    this.lastActive = now;
    if (this.status === 'running') {
      p.left = true;
      p.online = false;
      if (p.role === 'hider' && !p.caught) this.markCaught(id, id, now);
    } else {
      this.players.delete(id);
    }
    if (this.hostId === id) {
      const next = [...this.players.values()].find((x) => !x.left && x.id !== id);
      this.hostId = next ? next.id : null;
    }
  }

  isEmpty() {
    return [...this.players.values()].every((p) => p.left) || this.players.size === 0;
  }

  updateSettings(patch) {
    if (this.status !== 'lobby') throw new GameError('Les réglages sont verrouillés pendant la partie.');
    const next = { ...this.settings };
    if (patch.city !== undefined) {
      const c = patch.city;
      if (!c || typeof c.name !== 'string' || !isLat(c.lat) || !isLng(c.lng)) {
        throw new GameError('Ville invalide.');
      }
      next.city = { name: c.name.trim().slice(0, 80) || 'Zone', lat: c.lat, lng: c.lng };
    }
    if (patch.radius !== undefined) next.radius = toInt(patch.radius, 200, 30000, 'rayon');
    if (patch.headStartMin !== undefined) next.headStartMin = toInt(patch.headStartMin, 0, 60, 'avance');
    if (patch.pingEveryMin !== undefined) next.pingEveryMin = toInt(patch.pingEveryMin, 1, 30, 'intervalle');
    if (patch.hidersSeeHiders !== undefined) next.hidersSeeHiders = Boolean(patch.hidersSeeHiders);
    this.settings = next;
  }

  assignRoles(rng) {
    const all = [...this.players.values()];
    const count = (r) => all.filter((p) => p.role === r).length;
    if (count('hider') === 0 || count('hunter') === 0) all.forEach((p) => (p.role = null));
    let hiders = count('hider');
    let hunters = count('hunter');
    for (const p of shuffle(all.filter((x) => !x.role), rng)) {
      const hider = hiders < hunters ? true : hunters < hiders ? false : rng() < 0.5;
      p.role = hider ? 'hider' : 'hunter';
      if (hider) hiders++;
      else hunters++;
    }
  }

  start(now = Date.now(), rng = Math.random) {
    if (this.status !== 'lobby') throw new GameError('La partie est déjà lancée.');
    if (this.players.size < 2) throw new GameError('Il faut au moins 2 joueurs.');
    if (!this.settings.city) throw new GameError('Choisissez une ville avant de lancer.');
    this.assignRoles(rng);
    for (const p of this.players.values()) {
      p.caught = false;
      p.caughtAt = null;
    }
    this.pings.clear();
    this.round++;
    this.status = 'running';
    this.startedAt = now;
    this.releaseAt = now + this.settings.headStartMin * MIN;
    this.nextPingAt = this.releaseAt;
    this.endedAt = null;
    this.lastActive = now;
    this.tick(now);
  }

  setPosition(id, lat, lng, acc, now = Date.now()) {
    const p = this.players.get(id);
    if (!p || !isLat(lat) || !isLng(lng)) return;
    p.live = { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null, ts: now };
  }

  // Avance l'horloge de la partie. Renvoie true si l'état visible a changé.
  tick(now = Date.now()) {
    if (this.status !== 'running' || now < this.nextPingAt) return false;
    for (const p of this.players.values()) {
      if (p.role !== 'hider' || p.caught || !p.live) continue;
      this.pings.set(p.id, {
        lat: p.live.lat,
        lng: p.live.lng,
        acc: p.live.acc,
        fixAt: p.live.ts,
        ts: now,
      });
    }
    const every = this.settings.pingEveryMin * MIN;
    this.nextPingAt += every * (Math.floor((now - this.nextPingAt) / every) + 1);
    return true;
  }

  markCaught(actorId, targetId, now = Date.now()) {
    if (this.status !== 'running') throw new GameError("La partie n'est pas en cours.");
    const actor = this.players.get(actorId);
    const target = this.players.get(targetId);
    if (!actor || !target || target.role !== 'hider') throw new GameError('Joueur introuvable.');
    if (target.caught) return;
    const self = actorId === targetId;
    if (!self) {
      if (actor.role !== 'hunter') throw new GameError('Seuls les hunters peuvent attraper un hider.');
      if (now < this.releaseAt) throw new GameError("Les hunters ne sont pas encore lâchés.");
    }
    target.caught = true;
    target.caughtAt = now;
    this.lastActive = now;
    const alive = [...this.players.values()].some((p) => p.role === 'hider' && !p.caught);
    if (!alive) this.end(now);
  }

  end(now = Date.now()) {
    if (this.status !== 'running') throw new GameError("La partie n'est pas en cours.");
    this.status = 'ended';
    this.endedAt = now;
    this.lastActive = now;
  }

  // Retour au salon : les rôles sont inversés.
  nextRound(now = Date.now()) {
    if (this.status !== 'ended') throw new GameError("La manche n'est pas terminée.");
    for (const [id, p] of this.players) if (p.left) this.players.delete(id);
    for (const p of this.players.values()) {
      p.role = p.role === 'hider' ? 'hunter' : p.role === 'hunter' ? 'hider' : null;
      p.caught = false;
      p.caughtAt = null;
    }
    this.pings.clear();
    this.status = 'lobby';
    this.startedAt = this.releaseAt = this.nextPingAt = this.endedAt = null;
    this.lastActive = now;
  }

  // Ce que `viewerId` a le droit de voir. Les positions en direct ne sortent jamais.
  view(viewerId, now = Date.now()) {
    const me = this.players.get(viewerId);
    const reveal = this.status === 'ended';
    const pings = [];
    for (const [id, ping] of this.pings) {
      const target = this.players.get(id);
      if (!target || (target.caught && !reveal)) continue;
      const allowed =
        reveal ||
        id === viewerId ||
        me?.role === 'hunter' ||
        (me?.role === 'hider' && this.settings.hidersSeeHiders);
      if (allowed) pings.push({ id, lat: ping.lat, lng: ping.lng, ts: ping.ts, fixAt: ping.fixAt });
    }
    const hiders = [...this.players.values()].filter((p) => p.role === 'hider');
    return {
      code: this.code,
      status: this.status,
      round: this.round,
      now,
      me: viewerId,
      hostId: this.hostId,
      settings: this.settings,
      startedAt: this.startedAt,
      releaseAt: this.releaseAt,
      nextPingAt: this.status === 'running' ? this.nextPingAt : null,
      endedAt: this.endedAt,
      allCaught: this.status === 'ended' && hiders.length > 0 && hiders.every((p) => p.caught),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        caught: p.caught,
        caughtAt: p.caughtAt,
        online: p.online,
        left: p.left,
      })),
      pings,
    };
  }
}

module.exports = { Room, GameError, makeCode, MIN, MAX_PLAYERS };
