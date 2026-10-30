'use strict';

const crypto = require('crypto');

const MIN = 60 * 1000;
const MAX_PLAYERS = 30;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_CHAT = 150;
const CHAT_LEN = 200;
const ZONE_TOLERANCE = 40; // mètres de marge pour l'imprécision du GPS en bord de zone
const MIN_RADIUS = 50; // en dessous, l'imprécision du GPS déclencherait de fausses sorties de zone

// Marge GPS en bord de zone : la précision annoncée, plafonnée à 40 m et au quart du rayon.
const zoneMargin = (acc, radius) => Math.min(acc ?? 0, ZONE_TOLERANCE, radius / 4);

// Barème des points de la manche.
const POINTS = {
  perMinute: 10, // hider : par minute en fuite après le lâcher des hunters
  survive: 50, // hider : encore libre quand le temps est écoulé
  catch: 100, // hunter : par capture
  sweep: 50, // hunter : tous les hiders attrapés avant la fin
};

const DEFAULT_SETTINGS = {
  city: null, // { name, lat, lng }
  radius: 5000, // mètres
  headStartMin: 10,
  pingEveryMin: 5,
  durationMin: 60, // durée de la chasse, après l'avance ; 0 = illimitée
  hidersSeeHiders: true,
  caughtDisplay: 'cross', // 'cross' : une tombe là où le hider a été attrapé ; 'none' : plus rien
  roleMode: 'swap', // 'swap' : inversés à chaque manche ; 'random' : tirés au sort ; 'manual' : choisis par l'hôte
  hunterCount: 0, // 0 = moitié-moitié
  outGraceSec: 30, // secondes hors zone avant que la position d'un hider soit révélée ; 0 = simple alerte
};

const ROLE_MODES = ['swap', 'random', 'manual'];

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

function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
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
    this.status = 'lobby'; // lobby | running | ended | final
    this.round = 0; // nombre de manches lancées
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = new Map();
    this.hostId = null;
    this.startedAt = null;
    this.releaseAt = null; // fin de l'avance : les hunters partent
    this.nextPingAt = null;
    this.endedAt = null;
    this.endsAt = null; // fin programmée de la chasse, null si illimitée
    this.endReason = null; // 'caught' | 'time' | 'host'
    this.lastRound = null; // id -> points gagnés à la dernière manche
    this.pings = new Map(); // id du hider -> dernier ping partagé
    this.catches = new Map(); // id du hider -> lieu de la capture
    this.chat = [];
    this.chatSeq = 0;
    this.conns = new Map(); // id -> websocket (géré par le transport)
  }

  addPlayer(name, now = Date.now()) {
    if (this.status !== 'lobby') throw new GameError('La partie a déjà commencé.');
    if (this.players.size >= MAX_PLAYERS) throw new GameError('Le salon est plein.');
    const clean = cleanName(name);
    if (!clean) throw new GameError('Entre un pseudo.');
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
      caughtBy: null,
      left: false,
      online: false,
      live: null, // dernière position GPS reçue, jamais diffusée telle quelle
      outSince: null, // hors zone depuis
      exposed: false, // resté trop longtemps hors zone : position révélée
      score: 0,
      hunterRounds: 0,
      lastRole: null,
      seed: crypto.randomInt(2 ** 31), // départage stable pour la rotation des rôles
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.lastActive = now;
    this.planRoles();
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
      if (p.role === 'hider' && !p.caught) {
        this.markCaught(id, id, now);
        this.catches.delete(id); // un abandon n'est pas une capture : pas de tombe
      }
    } else {
      this.players.delete(id);
      this.planRoles();
    }
    if (this.hostId === id) {
      const next = [...this.players.values()].find((x) => !x.left && x.id !== id);
      this.hostId = next ? next.id : null;
    }
  }

  kick(targetId, now = Date.now()) {
    const p = this.players.get(targetId);
    if (!p || p.left) throw new GameError('Joueur introuvable.');
    if (targetId === this.hostId) throw new GameError("L'hôte ne peut pas s'exclure lui-même.");
    this.removePlayer(targetId, now);
  }

  setHost(targetId) {
    const p = this.players.get(targetId);
    if (!p || p.left) throw new GameError('Joueur introuvable.');
    this.hostId = targetId;
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
    if (patch.radius !== undefined) next.radius = toInt(patch.radius, MIN_RADIUS, 30000, 'rayon');
    if (patch.headStartMin !== undefined) next.headStartMin = toInt(patch.headStartMin, 0, 60, 'avance');
    if (patch.pingEveryMin !== undefined) next.pingEveryMin = toInt(patch.pingEveryMin, 1, 30, 'intervalle');
    if (patch.durationMin !== undefined) next.durationMin = toInt(patch.durationMin, 0, 480, 'durée');
    if (patch.hidersSeeHiders !== undefined) next.hidersSeeHiders = Boolean(patch.hidersSeeHiders);
    if (patch.caughtDisplay !== undefined) {
      if (patch.caughtDisplay !== 'cross' && patch.caughtDisplay !== 'none') {
        throw new GameError('Réglage invalide : hiders attrapés.');
      }
      next.caughtDisplay = patch.caughtDisplay;
    }
    if (patch.roleMode !== undefined) {
      if (!ROLE_MODES.includes(patch.roleMode)) throw new GameError('Réglage invalide : répartition des rôles.');
      next.roleMode = patch.roleMode;
    }
    if (patch.hunterCount !== undefined) next.hunterCount = toInt(patch.hunterCount, 0, MAX_PLAYERS - 1, 'hunters');
    if (patch.outGraceSec !== undefined) next.outGraceSec = toInt(patch.outGraceSec, 0, 600, 'sortie de zone');
    this.settings = next;
    this.planRoles();
  }

  // Nombre de hunters voulu pour `n` joueurs.
  hunterTarget(n) {
    const want = this.settings.hunterCount;
    return want ? clamp(want, 1, n - 1) : Math.floor(n / 2);
  }

  // Rôles affichés dans le salon. En mode « inversés », la manche suivante est connue d'avance :
  // ceux qui viennent d'être hunters passent hiders, puis ceux qui ont le moins chassé.
  planRoles() {
    if (this.status !== 'lobby') return;
    const mode = this.settings.roleMode;
    const all = [...this.players.values()];
    if (mode === 'manual') return;
    if (mode === 'random' || this.round === 0) {
      all.forEach((p) => (p.role = null));
      return;
    }
    const target = this.hunterTarget(all.length);
    const order = [...all].sort(
      (a, b) =>
        (a.lastRole === 'hunter') - (b.lastRole === 'hunter') ||
        a.hunterRounds - b.hunterRounds ||
        a.seed - b.seed
    );
    order.forEach((p, i) => (p.role = i < target ? 'hunter' : 'hider'));
  }

  // Complète au hasard les rôles manquants (tirage, ou joueurs que l'hôte n'a pas placés).
  drawRoles(rng) {
    const all = [...this.players.values()];
    const target = this.hunterTarget(all.length);
    let hunters = all.filter((p) => p.role === 'hunter').length;
    for (const p of shuffle(all.filter((x) => !x.role), rng)) {
      p.role = hunters < target ? 'hunter' : 'hider';
      if (p.role === 'hunter') hunters++;
    }
  }

  setRole(targetId, role) {
    if (this.status !== 'lobby') throw new GameError('Les rôles se choisissent dans le salon.');
    if (this.settings.roleMode !== 'manual') throw new GameError('Passe la répartition en mode « à la main ».');
    const p = this.players.get(targetId);
    if (!p) throw new GameError('Joueur introuvable.');
    if (role !== 'hider' && role !== 'hunter' && role !== null) throw new GameError('Rôle invalide.');
    p.role = role;
  }

  start(now = Date.now(), rng = Math.random) {
    if (this.status !== 'lobby') throw new GameError('La partie est déjà lancée.');
    if (this.players.size < 2) throw new GameError('Il faut au moins 2 joueurs.');
    if (!this.settings.city) throw new GameError('Choisis une ville avant de lancer.');
    this.planRoles();
    this.drawRoles(rng);
    const all = [...this.players.values()];
    if (!all.some((p) => p.role === 'hider') || !all.some((p) => p.role === 'hunter')) {
      throw new GameError('Il faut au moins un hider et un hunter.');
    }
    for (const p of all) {
      p.caught = false;
      p.caughtAt = null;
      p.caughtBy = null;
      p.outSince = null;
      p.exposed = false;
      p.lastRole = p.role;
      if (p.role === 'hunter') p.hunterRounds++;
    }
    this.pings.clear();
    this.catches.clear();
    this.chat = this.chat.filter((m) => m.ch === 'all');
    this.lastRound = null;
    this.round++;
    this.status = 'running';
    this.startedAt = now;
    this.releaseAt = now + this.settings.headStartMin * MIN;
    this.nextPingAt = this.releaseAt;
    this.endedAt = null;
    this.endsAt = this.settings.durationMin ? this.releaseAt + this.settings.durationMin * MIN : null;
    this.endReason = null;
    this.lastActive = now;
    this.tick(now);
  }

  // Renvoie true si l'état visible a changé.
  setPosition(id, lat, lng, acc, now = Date.now()) {
    const p = this.players.get(id);
    if (!p || p.caught || !isLat(lat) || !isLng(lng)) return false; // un hider attrapé n'est plus localisé
    p.live = { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null, ts: now };
    return this.checkZone(p, now);
  }

  // Un hider qui reste hors zone plus de `outGraceSec` voit sa position révélée en continu.
  checkZone(p, now) {
    const { city, radius, outGraceSec } = this.settings;
    const watched = this.status === 'running' && p.role === 'hider' && !p.caught && !p.left && p.live && city;
    const out = watched && distance(p.live, city) > radius + zoneMargin(p.live.acc, radius);
    if (!out) {
      const changed = p.outSince !== null || p.exposed;
      p.outSince = null;
      p.exposed = false;
      return changed;
    }
    let changed = false;
    if (p.outSince === null) {
      p.outSince = now;
      changed = true;
    }
    if (outGraceSec > 0 && now - p.outSince >= outGraceSec * 1000) {
      const ping = this.pings.get(p.id);
      if (!p.exposed || ping?.fixAt !== p.live.ts) {
        p.exposed = true;
        this.pings.set(p.id, { lat: p.live.lat, lng: p.live.lng, acc: p.live.acc, fixAt: p.live.ts, ts: now, out: true });
        changed = true;
      }
    }
    return changed;
  }

  // Avance l'horloge de la partie. Renvoie true si l'état visible a changé.
  tick(now = Date.now()) {
    if (this.status !== 'running') return false;
    if (this.endsAt !== null && now >= this.endsAt) {
      this.end(this.endsAt, 'time');
      return true;
    }
    let changed = false;
    for (const p of this.players.values()) if (this.checkZone(p, now)) changed = true;
    if (now < this.nextPingAt) return changed;
    for (const p of this.players.values()) {
      if (p.role !== 'hider' || p.caught || !p.live) continue;
      this.pings.set(p.id, {
        lat: p.live.lat,
        lng: p.live.lng,
        acc: p.live.acc,
        fixAt: p.live.ts,
        ts: now,
        out: p.exposed,
      });
    }
    const every = this.settings.pingEveryMin * MIN;
    this.nextPingAt += every * (Math.floor((now - this.nextPingAt) / every) + 1);
    return true;
  }

  // `byId` : le hunter désigné par un hider qui se déclare attrapé (facultatif).
  markCaught(actorId, targetId, now = Date.now(), byId = null) {
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
    const by = self ? this.players.get(byId) : actor;
    target.caught = true;
    target.caughtAt = now;
    target.caughtBy = by?.role === 'hunter' ? by.id : null;
    target.outSince = null;
    target.exposed = false;
    if (target.live) this.catches.set(targetId, { lat: target.live.lat, lng: target.live.lng, ts: now });
    this.pings.delete(targetId);
    this.lastActive = now;
    const alive = [...this.players.values()].some((p) => p.role === 'hider' && !p.caught);
    if (!alive) this.end(now, 'caught');
  }

  end(now = Date.now(), reason = 'host') {
    if (this.status !== 'running') throw new GameError("La partie n'est pas en cours.");
    this.status = 'ended';
    this.endReason = reason;
    this.endedAt = now;
    this.lastActive = now;
    this.scoreRound(now);
  }

  scoreRound(now) {
    const all = [...this.players.values()];
    const hunters = all.filter((p) => p.role === 'hunter' && !p.left);
    const res = {};
    for (const p of all) res[p.id] = { pts: 0, catches: 0, survivedMs: null, survived: false };
    let unclaimed = 0;
    for (const h of all.filter((p) => p.role === 'hider')) {
      const r = res[h.id];
      r.survivedMs = Math.max(0, (h.caught ? h.caughtAt : now) - this.releaseAt);
      r.pts += Math.floor(r.survivedMs / MIN) * POINTS.perMinute;
      if (!h.caught) {
        r.survived = true;
        if (this.endReason === 'time') r.pts += POINTS.survive;
      } else if (!h.left) {
        if (h.caughtBy && res[h.caughtBy]) {
          res[h.caughtBy].catches++;
          res[h.caughtBy].pts += POINTS.catch;
        } else unclaimed++;
      }
    }
    for (const p of hunters) {
      if (unclaimed) res[p.id].pts += Math.round((unclaimed * POINTS.catch) / hunters.length);
      if (this.endReason === 'caught') res[p.id].pts += POINTS.sweep;
    }
    for (const p of all) p.score += res[p.id].pts;
    this.lastRound = res;
  }

  // Retour au salon pour la manche suivante.
  nextRound(now = Date.now()) {
    if (this.status !== 'ended') throw new GameError("La manche n'est pas terminée.");
    this.toLobby(now);
  }

  // Podium de fin de soirée, depuis le salon ou un écran de fin de manche.
  finish(now = Date.now()) {
    if (this.status !== 'ended' && this.status !== 'lobby') throw new GameError('Termine la manche en cours.');
    if (this.round === 0) throw new GameError('Joue au moins une manche.');
    for (const [id, p] of this.players) if (p.left) this.players.delete(id);
    this.status = 'final';
    this.lastActive = now;
  }

  // Nouvelle partie après le podium : scores à zéro.
  reset(now = Date.now()) {
    if (this.status !== 'final') throw new GameError("La partie n'est pas terminée.");
    for (const p of this.players.values()) {
      p.score = 0;
      p.hunterRounds = 0;
      p.lastRole = null;
      p.role = null;
    }
    this.round = 0;
    this.toLobby(now);
  }

  toLobby(now) {
    for (const [id, p] of this.players) if (p.left) this.players.delete(id);
    for (const p of this.players.values()) {
      p.caught = false;
      p.caughtAt = null;
      p.caughtBy = null;
      p.outSince = null;
      p.exposed = false;
    }
    this.pings.clear();
    this.catches.clear();
    this.chat = this.chat.filter((m) => m.ch === 'all');
    this.status = 'lobby';
    this.startedAt = this.releaseAt = this.nextPingAt = this.endedAt = this.endsAt = this.endReason = null;
    this.lastActive = now;
    this.planRoles();
  }

  // Pendant la manche, un message part à l'équipe sauf si `ch` vaut 'all'.
  addChat(id, text, ch, now = Date.now()) {
    const p = this.players.get(id);
    if (!p || p.left) throw new GameError('Joueur introuvable.');
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, CHAT_LEN);
    if (!clean) return false;
    const channel = this.status === 'running' && ch !== 'all' && p.role ? p.role : 'all';
    this.chat.push({ id: ++this.chatSeq, from: id, name: p.name, ch: channel, text: clean, ts: now });
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    this.lastActive = now;
    return true;
  }

  // Ce que `viewerId` a le droit de voir. Les positions en direct ne sortent jamais.
  view(viewerId, now = Date.now()) {
    const me = this.players.get(viewerId);
    const reveal = this.status === 'ended' || this.status === 'final';
    const pings = [];
    for (const [id, ping] of this.pings) {
      const target = this.players.get(id);
      if (!target || (target.caught && !reveal)) continue;
      const allowed =
        reveal ||
        id === viewerId ||
        me?.role === 'hunter' ||
        (me?.role === 'hider' && this.settings.hidersSeeHiders);
      if (allowed) pings.push({ id, lat: ping.lat, lng: ping.lng, ts: ping.ts, fixAt: ping.fixAt, out: Boolean(ping.out) });
    }
    const catches = [];
    if (this.settings.caughtDisplay === 'cross') {
      for (const [id, spot] of this.catches) {
        const sees =
          reveal || id === viewerId || me?.role === 'hunter' || (me?.role === 'hider' && this.settings.hidersSeeHiders);
        if (sees && this.players.has(id)) catches.push({ id, lat: spot.lat, lng: spot.lng, ts: spot.ts });
      }
    }
    // Les messages d'équipe restent dans l'équipe jusqu'à la fin de la manche.
    const chat = this.chat.filter((m) => m.ch === 'all' || reveal || m.ch === me?.role).slice(-80);
    const hiders = [...this.players.values()].filter((p) => p.role === 'hider');
    return {
      code: this.code,
      status: this.status,
      round: this.round,
      now,
      me: viewerId,
      hostId: this.hostId,
      settings: this.settings,
      points: POINTS,
      startedAt: this.startedAt,
      releaseAt: this.releaseAt,
      nextPingAt: this.status === 'running' ? this.nextPingAt : null,
      endedAt: this.endedAt,
      endsAt: this.endsAt,
      endReason: this.endReason,
      allCaught: this.status === 'ended' && hiders.length > 0 && hiders.every((p) => p.caught),
      lastRound: this.lastRound,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        caught: p.caught,
        caughtAt: p.caughtAt,
        caughtBy: p.caughtBy,
        online: p.online,
        left: p.left,
        score: p.score,
        exposed: p.exposed,
        outSince: p.id === viewerId ? p.outSince : null, // le compte à rebours ne regarde que soi
      })),
      pings,
      catches,
      chat,
    };
  }

  toJSON() {
    const { conns, players, pings, catches, ...rest } = this;
    return { ...rest, players: [...players.values()], pings: [...pings], catches: [...catches] };
  }

  static fromJSON(data) {
    const { players, pings, catches, ...rest } = data;
    const room = new Room(data.code, data.createdAt);
    Object.assign(room, rest);
    room.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    room.players = new Map(players.map((p) => [p.id, { ...p, online: false }]));
    room.pings = new Map(pings);
    room.catches = new Map(catches);
    room.conns = new Map();
    return room;
  }
}

module.exports = { Room, GameError, makeCode, distance, MIN, MAX_PLAYERS, POINTS };
