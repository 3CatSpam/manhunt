'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, GameError, MIN } = require('../game');

const T0 = 1_000_000;
const PARIS = { name: 'Paris', lat: 48.8566, lng: 2.3522 };

function lobby(names = ['Ana', 'Ben', 'Cam', 'Dan']) {
  const room = new Room('ABCD', T0);
  const players = names.map((n) => room.addPlayer(n, T0));
  room.updateSettings({ city: PARIS });
  return { room, players };
}

const seq = (...vals) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

test('la moitié des joueurs sont hiders au premier tour', () => {
  const { room } = lobby();
  room.start(T0);
  const roles = [...room.players.values()].map((p) => p.role);
  assert.equal(roles.filter((r) => r === 'hider').length, 2);
  assert.equal(roles.filter((r) => r === 'hunter').length, 2);
});

test('nombre impair : les deux camps diffèrent au plus de 1', () => {
  const { room } = lobby(['A', 'B', 'C', 'D', 'E']);
  room.start(T0);
  const h = [...room.players.values()].filter((p) => p.role === 'hider').length;
  assert.ok(h === 2 || h === 3);
});

test('refuse de démarrer seul ou sans ville', () => {
  const solo = new Room('SOLO', T0);
  solo.addPlayer('Seul', T0);
  solo.updateSettings({ city: PARIS });
  assert.throws(() => solo.start(T0), GameError);
  const { room } = lobby();
  room.settings = { ...room.settings, city: null };
  assert.throws(() => room.start(T0), GameError);
});

test('pseudos uniques et non vides', () => {
  const { room } = lobby(['Ana']);
  assert.throws(() => room.addPlayer('ana', T0), /déjà pris/);
  assert.throws(() => room.addPlayer('   ', T0), GameError);
});

test('premier ping à la fin de l’avance, puis toutes les 5 minutes', () => {
  const { room } = lobby();
  room.start(T0);
  const hider = [...room.players.values()].find((p) => p.role === 'hider');
  room.setPosition(hider.id, 48.85, 2.35, 10, T0 + 1000);

  assert.equal(room.tick(T0 + 9 * MIN), false);
  assert.equal(room.pings.size, 0);

  assert.equal(room.tick(T0 + 10 * MIN), true);
  assert.equal(room.pings.get(hider.id).ts, T0 + 10 * MIN);
  assert.equal(room.nextPingAt, T0 + 15 * MIN);

  room.setPosition(hider.id, 48.86, 2.36, 10, T0 + 12 * MIN);
  assert.equal(room.tick(T0 + 14 * MIN), false);
  assert.equal(room.pings.get(hider.id).lat, 48.85, 'le ping reste figé entre deux échéances');
  assert.equal(room.tick(T0 + 15 * MIN), true);
  assert.equal(room.pings.get(hider.id).lat, 48.86);
});

test('un long silence du serveur ne rejoue pas les pings manqués', () => {
  const { room } = lobby();
  room.start(T0);
  room.tick(T0 + 47 * MIN);
  assert.equal(room.nextPingAt, T0 + 50 * MIN);
});

test('les hunters voient les pings, les hiders selon le réglage', () => {
  const { room } = lobby();
  room.start(T0);
  const [h1, h2] = [...room.players.values()].filter((p) => p.role === 'hider');
  const hunter = [...room.players.values()].find((p) => p.role === 'hunter');
  room.setPosition(h1.id, 48.1, 2.1, 5, T0);
  room.setPosition(h2.id, 48.2, 2.2, 5, T0);
  room.tick(T0 + 10 * MIN);

  assert.equal(room.view(hunter.id).pings.length, 2);
  assert.equal(room.view(h1.id).pings.length, 2, 'réglage par défaut : alliés visibles');

  room.settings = { ...room.settings, hidersSeeHiders: false };
  const own = room.view(h1.id).pings;
  assert.deepEqual(own.map((p) => p.id), [h1.id], 'seul son propre ping reste visible');
  assert.equal(room.view(hunter.id).pings.length, 2);
});

test('les positions en direct ne fuient jamais dans la vue', () => {
  const { room } = lobby();
  room.start(T0);
  const hider = [...room.players.values()].find((p) => p.role === 'hider');
  room.setPosition(hider.id, 48.123456, 2.654321, 5, T0);
  const json = JSON.stringify(room.view(hider.id));
  assert.ok(!json.includes('48.123456'));
});

test('les hunters ne peuvent pas attraper pendant l’avance', () => {
  const { room } = lobby();
  room.start(T0);
  const hider = [...room.players.values()].find((p) => p.role === 'hider');
  const hunter = [...room.players.values()].find((p) => p.role === 'hunter');
  assert.throws(() => room.markCaught(hunter.id, hider.id, T0 + MIN), /pas encore lâchés/);
  room.markCaught(hunter.id, hider.id, T0 + 11 * MIN);
  assert.equal(hider.caught, true);
});

test('un hider ne peut pas en attraper un autre', () => {
  const { room } = lobby();
  room.start(T0);
  const [h1, h2] = [...room.players.values()].filter((p) => p.role === 'hider');
  assert.throws(() => room.markCaught(h1.id, h2.id, T0 + 11 * MIN), GameError);
});

test('la manche se termine quand tous les hiders sont attrapés, puis les rôles s’inversent', () => {
  const { room } = lobby();
  room.start(T0, seq(0.1, 0.9));
  const before = new Map([...room.players.values()].map((p) => [p.id, p.role]));
  const hunter = [...room.players.values()].find((p) => p.role === 'hunter');
  const hiders = [...room.players.values()].filter((p) => p.role === 'hider');

  room.markCaught(hunter.id, hiders[0].id, T0 + 11 * MIN);
  assert.equal(room.status, 'running');
  room.markCaught(hiders[1].id, hiders[1].id, T0 + 20 * MIN);
  assert.equal(room.status, 'ended');
  assert.equal(room.view(hunter.id).allCaught, true);

  room.nextRound(T0 + 21 * MIN);
  assert.equal(room.status, 'lobby');
  for (const p of room.players.values()) {
    assert.notEqual(p.role, before.get(p.id));
    assert.equal(p.caught, false);
  }
  room.start(T0 + 22 * MIN);
  assert.equal(room.round, 2);
});

test('en fin de partie les pings des hiders encore libres sont révélés à tous', () => {
  const { room } = lobby();
  room.updateSettings({ hidersSeeHiders: false });
  room.start(T0);
  const [h1, h2] = [...room.players.values()].filter((p) => p.role === 'hider');
  const hunter = [...room.players.values()].find((p) => p.role === 'hunter');
  room.setPosition(h1.id, 48.1, 2.1, 5, T0);
  room.setPosition(h2.id, 48.2, 2.2, 5, T0);
  room.tick(T0 + 10 * MIN);
  room.markCaught(hunter.id, h1.id, T0 + 11 * MIN);
  assert.equal(room.view(hunter.id).pings.length, 1, 'un hider attrapé disparaît de la carte');
  assert.deepEqual(room.view(h2.id).pings.map((p) => p.id), [h2.id]);
  room.end(T0 + 12 * MIN);
  assert.equal(room.view(h2.id).pings.length, 1);
});

test('un hider attrapé n’est plus pingé ni localisé', () => {
  const { room } = lobby();
  room.start(T0);
  const [h1, h2] = [...room.players.values()].filter((p) => p.role === 'hider');
  const hunter = [...room.players.values()].find((p) => p.role === 'hunter');
  room.setPosition(h1.id, 48.1, 2.1, 5, T0);
  room.setPosition(h2.id, 48.2, 2.2, 5, T0);
  room.tick(T0 + 10 * MIN);
  room.markCaught(hunter.id, h1.id, T0 + 11 * MIN);
  room.setPosition(h1.id, 49, 3, 5, T0 + 12 * MIN); // son téléphone continue d'envoyer
  room.tick(T0 + 15 * MIN);
  assert.equal(room.pings.has(h1.id), false);
  assert.equal(room.pings.get(h2.id).ts, T0 + 15 * MIN, 'les autres continuent d’être pingés');
});

test('réglage « croix » : le lieu de capture est visible des hunters et des hiders autorisés', () => {
  const { room } = lobby();
  room.start(T0);
  const [h1, h2] = [...room.players.values()].filter((p) => p.role === 'hider');
  const hunter = [...room.players.values()].find((p) => p.role === 'hunter');
  room.setPosition(h1.id, 48.1, 2.1, 5, T0);
  room.markCaught(hunter.id, h1.id, T0 + 11 * MIN);

  const spot = room.view(hunter.id).catches;
  assert.equal(spot.length, 1);
  assert.deepEqual([spot[0].id, spot[0].lat, spot[0].lng], [h1.id, 48.1, 2.1]);
  assert.equal(room.view(h2.id).catches.length, 1, 'alliés visibles par défaut');
  assert.equal(room.view(h1.id).catches.length, 1);

  room.settings = { ...room.settings, hidersSeeHiders: false };
  assert.equal(room.view(h2.id).catches.length, 0);
  assert.equal(room.view(hunter.id).catches.length, 1);
});

test('réglage « rien » : aucune trace du hider attrapé', () => {
  const { room } = lobby();
  room.updateSettings({ caughtDisplay: 'none' });
  room.start(T0);
  const [h1] = [...room.players.values()].filter((p) => p.role === 'hider');
  const hunter = [...room.players.values()].find((p) => p.role === 'hunter');
  room.setPosition(h1.id, 48.1, 2.1, 5, T0);
  room.markCaught(hunter.id, h1.id, T0 + 11 * MIN);
  assert.equal(room.view(hunter.id).catches.length, 0);
  assert.equal(room.view(hunter.id).pings.length, 0);
  assert.throws(() => room.updateSettings({ caughtDisplay: 'x' }), GameError);
});

test('un abandon ne laisse pas de croix', () => {
  const { room } = lobby();
  room.start(T0);
  const hider = [...room.players.values()].find((p) => p.role === 'hider');
  const hunter = [...room.players.values()].find((p) => p.role === 'hunter');
  room.setPosition(hider.id, 48.1, 2.1, 5, T0);
  room.removePlayer(hider.id, T0 + MIN);
  assert.equal(room.view(hunter.id).catches.length, 0);
});

test('les réglages sont validés et bornés', () => {
  const { room } = lobby();
  room.updateSettings({ radius: 999999, headStartMin: -5, pingEveryMin: 0 });
  assert.equal(room.settings.radius, 30000);
  assert.equal(room.settings.headStartMin, 0);
  assert.equal(room.settings.pingEveryMin, 1);
  assert.throws(() => room.updateSettings({ city: { name: 'x', lat: 200, lng: 0 } }), GameError);
  assert.throws(() => room.updateSettings({ radius: 'abc' }), GameError);
  room.start(T0);
  assert.throws(() => room.updateSettings({ radius: 1000 }), /verrouillés/);
});

test('la chasse se termine à l’heure : victoire des hiders', () => {
  const { room } = lobby();
  room.updateSettings({ durationMin: 30 });
  room.start(T0);
  assert.equal(room.endsAt, T0 + 40 * MIN, 'la durée court à partir de la fin de l’avance');
  assert.equal(room.tick(T0 + 39 * MIN), true, 'ping normal avant la fin');
  assert.equal(room.status, 'running');
  assert.equal(room.tick(T0 + 41 * MIN), true);
  assert.equal(room.status, 'ended');
  assert.equal(room.endedAt, T0 + 40 * MIN);
  const view = room.view([...room.players.keys()][0]);
  assert.equal(view.endReason, 'time');
  assert.equal(view.allCaught, false);
});

test('durée illimitée : aucune fin programmée', () => {
  const { room } = lobby();
  room.updateSettings({ durationMin: 0 });
  room.start(T0);
  assert.equal(room.endsAt, null);
  room.tick(T0 + 600 * MIN);
  assert.equal(room.status, 'running');
});

test('quitter en pleine partie fait perdre un hider', () => {
  const { room } = lobby();
  room.start(T0);
  const hider = [...room.players.values()].find((p) => p.role === 'hider');
  room.removePlayer(hider.id, T0 + MIN);
  assert.equal(hider.caught, true);
  assert.equal(hider.left, true);
});

const IN = [48.86, 2.35]; // dans la zone de Paris (5 km)
const OUT = [48.95, 2.35]; // à 10 km au nord
const role = (room, r) => [...room.players.values()].filter((p) => p.role === r);

test('hors zone : alerte puis position révélée au bout de 30 s', () => {
  const { room } = lobby();
  room.start(T0);
  const [hider] = role(room, 'hider');
  const [hunter] = role(room, 'hunter');
  room.setPosition(hider.id, ...IN, 5, T0 + MIN);
  assert.equal(hider.outSince, null);

  assert.equal(room.setPosition(hider.id, ...OUT, 5, T0 + 2 * MIN), true);
  assert.equal(room.view(hider.id).players.find((p) => p.id === hider.id).outSince, T0 + 2 * MIN);
  assert.equal(room.view(hunter.id).players.find((p) => p.id === hider.id).outSince, null, 'les autres ne le savent pas');
  room.tick(T0 + 2 * MIN + 29000);
  assert.equal(room.view(hunter.id).pings.length, 0, 'pas encore révélé');

  room.tick(T0 + 2 * MIN + 30000);
  assert.equal(hider.exposed, true);
  const [ping] = room.view(hunter.id).pings;
  assert.deepEqual([ping.lat, ping.out], [OUT[0], true]);

  room.setPosition(hider.id, 48.96, 2.35, 5, T0 + 3 * MIN);
  assert.equal(room.view(hunter.id).pings[0].lat, 48.96, 'suivi tant qu’il reste dehors');

  room.setPosition(hider.id, ...IN, 5, T0 + 4 * MIN);
  assert.equal(hider.exposed, false);
  assert.equal(hider.outSince, null);
});

test('petite zone : rayon de 50 m minimum, marge GPS réduite', () => {
  const { room } = lobby();
  room.updateSettings({ radius: 10 });
  assert.equal(room.settings.radius, 50);
  room.start(T0);
  const [hider] = role(room, 'hider');
  // 70 m au nord du centre, précision annoncée 30 m : dehors (marge plafonnée à 12,5 m)
  room.setPosition(hider.id, PARIS.lat + 70 / 111320, PARIS.lng, 30, T0);
  assert.notEqual(hider.outSince, null);
  // 55 m : dans la marge
  room.setPosition(hider.id, PARIS.lat + 55 / 111320, PARIS.lng, 30, T0 + 1000);
  assert.equal(hider.outSince, null);
});

test('hors zone en mode simple alerte : jamais révélé', () => {
  const { room } = lobby();
  room.updateSettings({ outGraceSec: 0 });
  room.start(T0);
  const [hider] = role(room, 'hider');
  room.setPosition(hider.id, ...OUT, 5, T0);
  room.tick(T0 + 5 * MIN);
  assert.equal(hider.outSince, T0);
  assert.equal(hider.exposed, false);
});

test('nombre de hunters réglable', () => {
  const { room } = lobby(['A', 'B', 'C', 'D', 'E', 'F']);
  room.updateSettings({ hunterCount: 1 });
  room.start(T0);
  assert.equal(role(room, 'hunter').length, 1);
  assert.equal(role(room, 'hider').length, 5);
});

test('mode « inversés » avec 1 hunter : chacun chasse à son tour', () => {
  const { room } = lobby(['A', 'B', 'C', 'D', 'E']);
  room.updateSettings({ hunterCount: 1 });
  const hunters = [];
  for (let i = 0; i < 5; i++) {
    room.start(T0 + i * 100 * MIN);
    hunters.push(role(room, 'hunter')[0].name);
    room.end(T0 + i * 100 * MIN + 1);
    room.nextRound(T0 + i * 100 * MIN + 2);
    assert.equal(role(room, 'hunter').length, 1, 'le prochain hunter est annoncé dans le salon');
  }
  assert.equal(new Set(hunters).size, 5);
});

test('mode « aléatoire » : rien n’est annoncé dans le salon', () => {
  const { room } = lobby();
  room.updateSettings({ roleMode: 'random' });
  room.start(T0);
  room.end(T0 + MIN);
  room.nextRound(T0 + 2 * MIN);
  assert.ok([...room.players.values()].every((p) => p.role === null));
});

test('mode « à la main » : l’hôte place les joueurs, le reste est complété', () => {
  const { room, players } = lobby();
  assert.throws(() => room.setRole(players[0].id, 'hunter'), /à la main/);
  room.updateSettings({ roleMode: 'manual' });
  room.setRole(players[0].id, 'hunter');
  room.setRole(players[1].id, 'hunter');
  room.setRole(players[2].id, 'hunter');
  room.start(T0);
  assert.deepEqual(
    players.map((p) => p.role),
    ['hunter', 'hunter', 'hunter', 'hider']
  );
  room.end(T0 + MIN);
  room.nextRound(T0 + 2 * MIN);
  assert.equal(players[0].role, 'hunter', 'les rôles restent tels quels');
  for (const p of players) room.setRole(p.id, 'hunter');
  assert.throws(() => room.start(T0 + 3 * MIN), /au moins un hider/);
});

test('l’hôte peut exclure un joueur et passer la main', () => {
  const { room, players } = lobby();
  const [host, ben] = players;
  assert.throws(() => room.kick(host.id), GameError);
  room.kick(ben.id, T0);
  assert.equal(room.players.has(ben.id), false);
  room.setHost(players[2].id);
  assert.equal(room.hostId, players[2].id);

  room.start(T0);
  const hider = role(room, 'hider').find((p) => p.id !== room.hostId);
  room.kick(hider.id, T0 + MIN);
  assert.equal(hider.left, true);
  assert.equal(room.findByToken(hider.token), null, 'un exclu ne peut pas reprendre sa session');
});

test('chat : les messages d’équipe restent secrets jusqu’à la fin de la manche', () => {
  const { room } = lobby();
  room.addChat(room.hostId, 'Salut tout le monde', 'team', T0);
  room.start(T0);
  const [h1, h2] = role(room, 'hider');
  const [hunter] = role(room, 'hunter');
  room.addChat(h1.id, 'Je suis au parc', 'team', T0 + MIN);
  room.addChat(hunter.id, 'Bonne chance', 'all', T0 + MIN);
  assert.equal(room.addChat(h1.id, '   ', 'team', T0 + MIN), false);

  assert.deepEqual(room.view(h2.id).chat.map((m) => m.text), ['Salut tout le monde', 'Je suis au parc', 'Bonne chance']);
  assert.deepEqual(room.view(hunter.id).chat.map((m) => m.text), ['Salut tout le monde', 'Bonne chance']);
  room.end(T0 + 2 * MIN);
  assert.equal(room.view(hunter.id).chat.length, 3, 'révélés en fin de manche');
  room.nextRound(T0 + 3 * MIN);
  assert.equal(room.view(hunter.id).chat.length, 2, 'effacés à la manche suivante');
});

test('scores : captures, minutes en fuite et cumul sur plusieurs manches', () => {
  const { room } = lobby();
  room.updateSettings({ headStartMin: 0, durationMin: 30 });
  room.start(T0);
  const [h1, h2] = role(room, 'hider');
  const [k1, k2] = role(room, 'hunter');
  room.markCaught(k1.id, h1.id, T0 + 12 * MIN + 30000);
  room.markCaught(h2.id, h2.id, T0 + 20 * MIN, k2.id); // se déclare attrapé par k2
  assert.equal(room.status, 'ended');
  assert.deepEqual(
    [h1, h2, k1, k2].map((p) => room.lastRound[p.id].pts),
    [120, 200, 150, 150]
  );
  assert.equal(room.lastRound[k1.id].catches, 1);

  room.nextRound(T0 + 21 * MIN);
  room.start(T0 + 22 * MIN);
  room.tick(T0 + 52 * MIN);
  assert.equal(room.endReason, 'time');
  assert.equal(room.lastRound[k1.id].pts, 30 * 10 + 50, 'ancien hunter : 30 min en fuite + bonus');
  assert.equal(k1.score, 150 + 350);
});

test('capture déclarée sans hunter : points partagés', () => {
  const { room } = lobby();
  room.updateSettings({ headStartMin: 0 });
  room.start(T0);
  const [h1] = role(room, 'hider');
  const [k1, k2] = role(room, 'hunter');
  room.markCaught(h1.id, h1.id, T0 + MIN);
  room.end(T0 + 2 * MIN);
  assert.equal(room.lastRound[k1.id].pts, 50);
  assert.equal(room.lastRound[k2.id].pts, 50);
});

test('podium puis nouvelle partie à zéro', () => {
  const { room } = lobby();
  assert.throws(() => room.finish(T0), /au moins une manche/);
  room.start(T0);
  assert.throws(() => room.finish(T0), /Termine la manche/);
  room.end(T0 + 20 * MIN);
  room.finish(T0 + 21 * MIN);
  assert.equal(room.status, 'final');
  assert.ok(room.view(room.hostId).players.some((p) => p.score > 0));
  room.reset(T0 + 22 * MIN);
  assert.equal(room.status, 'lobby');
  assert.equal(room.round, 0);
  assert.ok([...room.players.values()].every((p) => p.score === 0 && p.role === null));
});

test('sauvegarde : une partie en cours survit à un redémarrage', () => {
  const { room } = lobby();
  room.start(T0);
  const [hider] = role(room, 'hider');
  room.setPosition(hider.id, ...IN, 5, T0 + MIN);
  room.addChat(hider.id, 'coucou', 'team', T0 + MIN);

  const copy = Room.fromJSON(JSON.parse(JSON.stringify(room)));
  assert.equal(copy.status, 'running');
  assert.equal(copy.findByToken(hider.token).id, hider.id);
  assert.ok([...copy.players.values()].every((p) => !p.online));
  assert.equal(copy.conns.size, 0);
  copy.tick(T0 + 10 * MIN);
  assert.equal(copy.pings.get(hider.id).lat, IN[0]);
  assert.equal(copy.view(hider.id).chat.length, 1);
});
