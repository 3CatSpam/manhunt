'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Room, GameError, makeCode } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = 4096;

const rooms = new Map();

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, file) {
      // Le service worker doit toujours être revalidé pour que les mises à jour passent.
      if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  const now = Date.now();
  for (const [id, ws] of room.conns) send(ws, { type: 'state', state: room.view(id, now) });
}

function attach(ws, room, player) {
  const old = room.conns.get(player.id);
  if (old && old !== ws) {
    old.session = null;
    old.close(4000, 'replaced');
  }
  room.conns.set(player.id, ws);
  player.online = true;
  ws.session = { room, id: player.id };
  room.lastActive = Date.now();
}

function detach(ws) {
  const s = ws.session;
  ws.session = null;
  if (!s) return;
  const { room, id } = s;
  if (room.conns.get(id) === ws) room.conns.delete(id);
  const p = room.players.get(id);
  if (p) p.online = false;
  if (rooms.has(room.code)) broadcast(room);
}

function dropRoomIfEmpty(room) {
  if (room.isEmpty()) rooms.delete(room.code);
}

function handle(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const room = new Room(makeCode(rooms));
      const player = room.addPlayer(msg.name);
      rooms.set(room.code, room);
      attach(ws, room, player);
      send(ws, { type: 'joined', code: room.code, token: player.token });
      return broadcast(room);
    }
    case 'join': {
      const room = rooms.get(String(msg.code ?? '').toUpperCase());
      if (!room) throw new GameError('Aucune partie avec ce code.');
      const player = room.addPlayer(msg.name);
      attach(ws, room, player);
      send(ws, { type: 'joined', code: room.code, token: player.token });
      return broadcast(room);
    }
    case 'resume': {
      const room = rooms.get(String(msg.code ?? '').toUpperCase());
      const player = room?.findByToken(msg.token);
      if (!player) {
        send(ws, { type: 'gone' });
        return;
      }
      attach(ws, room, player);
      send(ws, { type: 'joined', code: room.code, token: player.token });
      return broadcast(room);
    }
  }

  const s = ws.session;
  if (!s) throw new GameError('Session expirée.');
  const { room, id } = s;
  const now = Date.now();
  const isHost = room.hostId === id;

  switch (msg.type) {
    case 'pos':
      if (now - (ws.lastPos ?? 0) < 2000) return;
      ws.lastPos = now;
      room.setPosition(id, msg.lat, msg.lng, msg.acc, now);
      return;
    case 'settings':
      if (!isHost) throw new GameError("Seul l'hôte peut changer les réglages.");
      room.updateSettings(msg.patch ?? {});
      break;
    case 'start':
      if (!isHost) throw new GameError("Seul l'hôte peut lancer la partie.");
      room.start(now);
      break;
    case 'caught':
      room.markCaught(id, msg.target ?? id, now);
      break;
    case 'end':
      if (!isHost) throw new GameError("Seul l'hôte peut terminer la partie.");
      room.end(now);
      break;
    case 'next':
      if (!isHost) throw new GameError("Seul l'hôte peut lancer la manche suivante.");
      room.nextRound(now);
      break;
    case 'leave':
      room.conns.delete(id);
      ws.session = null;
      room.removePlayer(id, now);
      dropRoomIfEmpty(room);
      if (rooms.has(room.code)) broadcast(room);
      return;
    default:
      return;
  }
  broadcast(room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.session = null;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      handle(ws, msg);
    } catch (err) {
      if (err instanceof GameError) send(ws, { type: 'error', message: err.message });
      else {
        console.error(err);
        send(ws, { type: 'error', message: 'Erreur du serveur.' });
      }
    }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

// Horloge de jeu : ping des positions, nettoyage des salons abandonnés.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.tick(now)) broadcast(room);
    if (room.conns.size === 0 && now - room.lastActive > ROOM_IDLE_MS) rooms.delete(room.code);
  }
}, 1000);

// Coupe les connexions mortes (téléphone passé en veille, tunnel…).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Manhunt prêt sur http://localhost:${PORT}`));
}

module.exports = { server, rooms };
