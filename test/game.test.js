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

  room.status = 'lobby';
  room.updateSettings({ hidersSeeHiders: false });
  room.status = 'running';
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
