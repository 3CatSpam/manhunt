(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    el.append(...kids.flat().filter((x) => x != null && x !== false));
    return el;
  }

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const pad = (n) => String(n).padStart(2, '0');

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    return (hh ? `${hh}:${pad(mm)}` : pad(mm)) + `:${pad(s % 60)}`;
  }

  function ageText(ms) {
    if (ms < 45000) return "à l'instant";
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return `il y a ${min} min`;
    return `il y a ${Math.floor(min / 60)} h ${pad(min % 60)}`;
  }

  function distance(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(x));
  }

  const plural = (n, one, many) => (n > 1 ? many : one);
  const roleLabel = (r) => (r === 'hider' ? 'Hider' : r === 'hunter' ? 'Hunter' : '');

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
  }

  const buzz = (pattern) => {
    try {
      navigator.vibrate?.(pattern);
    } catch {}
  };

  // ───────────── Session et connexion ─────────────

  const SESSION_KEY = 'manhunt.session';
  const NAME_KEY = 'manhunt.name';
  const read = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  };

  let session = null; // { code, token }
  try {
    session = JSON.parse(read(SESSION_KEY));
  } catch {}

  let state = null;
  let clockOffset = 0;
  let ws = null;
  let outbox = [];
  let retry = 0;
  let hideResult = false;

  const now = () => Date.now() + clockOffset;

  function connect() {
    if (ws && ws.readyState <= 1) return;
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      if (session) sock.send(JSON.stringify({ type: 'resume', code: session.code, token: session.token }));
      while (outbox.length) sock.send(JSON.stringify(outbox.shift()));
    };
    sock.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (err) {
        console.error(err);
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (session) setTimeout(connect, Math.min(8000, 700 * 2 ** retry++));
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    else {
      outbox.push(msg);
      connect();
    }
  }

  function sendLive(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function onMessage(m) {
    switch (m.type) {
      case 'joined':
        session = { code: m.code, token: m.token };
        write(SESSION_KEY, JSON.stringify(session));
        startGeo();
        break;
      case 'state':
        applyState(m.state);
        break;
      case 'gone':
        clearSession();
        toast("Cette partie n'existe plus.");
        break;
      case 'error':
        toast(m.message);
        break;
    }
  }

  function clearSession() {
    session = null;
    state = null;
    outbox = [];
    write(SESSION_KEY, null);
    stopGeo();
    releaseScreen();
    render();
  }

  function leave() {
    sendLive({ type: 'leave' });
    clearSession();
  }

  // ───────────── Localisation ─────────────

  const geo = { status: 'idle', pos: null, watchId: null, lastSent: 0 };

  function startGeo() {
    if (!('geolocation' in navigator)) {
      geo.status = 'unsupported';
      return renderGeo();
    }
    if (geo.watchId !== null) return;
    geo.status = geo.pos ? 'ok' : 'wait';
    geo.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 30000,
    });
    renderGeo();
  }

  function stopGeo() {
    if (geo.watchId !== null) navigator.geolocation.clearWatch(geo.watchId);
    geo.watchId = null;
    geo.pos = null;
    geo.status = 'idle';
  }

  function onPosition(p) {
    geo.status = 'ok';
    geo.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    pushPosition();
    renderGeo();
    updateMe();
    updateWarn();
  }

  function onGeoError(err) {
    if (err.code === 1) {
      geo.status = 'denied';
      if (geo.watchId !== null) navigator.geolocation.clearWatch(geo.watchId);
      geo.watchId = null;
    } else if (!geo.pos) geo.status = 'wait';
    renderGeo();
    updateWarn();
  }

  // Le serveur ne garde que la dernière position et ne la diffuse qu'aux échéances de ping.
  // Les hunters n'ont pas besoin d'envoyer la leur.
  function pushPosition(force) {
    if (!geo.pos || !state || myPlayer()?.role === 'hunter') return;
    const t = Date.now();
    if (!force && t - geo.lastSent < 8000) return;
    geo.lastSent = t;
    sendLive({ type: 'pos', lat: geo.pos.lat, lng: geo.pos.lng, acc: geo.pos.acc });
  }
  setInterval(() => pushPosition(true), 15000);

  function renderGeo() {
    const msgs = {
      idle: '',
      wait: 'Recherche de votre position…',
      ok: 'Position détectée.',
      denied:
        'Localisation refusée. Autorisez-la dans les réglages de votre navigateur puis touchez le bouton ci-dessous.',
      unsupported: "Votre navigateur ne gère pas la géolocalisation : impossible de jouer.",
    };
    $('geo-status').textContent = msgs[geo.status];
    $('geo-card').hidden = geo.status === 'ok';
    $('btn-geo').hidden = geo.status === 'wait' || geo.status === 'unsupported';
  }

  // ───────────── Écran allumé ─────────────

  let wake = null;
  async function holdScreen() {
    try {
      if ('wakeLock' in navigator && !wake && document.visibilityState === 'visible') {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => (wake = null));
      }
    } catch {}
  }
  function releaseScreen() {
    wake?.release().catch(() => {});
    wake = null;
  }

  // ───────────── État du jeu ─────────────

  const myPlayer = () => state?.players.find((p) => p.id === state.me);
  const isHost = () => state?.hostId === state?.me;
  const maxPingTs = (st) => st.pings.reduce((m, p) => Math.max(m, p.ts), 0);

  function applyState(next) {
    const prev = state;
    state = next;
    clockOffset = next.now - Date.now();

    if (!prev || prev.status !== next.status) {
      hideResult = false;
      if (prev?.status === 'lobby' && next.status === 'running') {
        toast(myPlayer()?.role === 'hider' ? 'Cachez-vous !' : "Attendez la fin de l'avance des hiders.");
        buzz([200, 100, 200]);
      }
      if (next.status === 'ended') buzz([300, 100, 300]);
    }
    if (prev && prev.status === 'running' && next.status === 'running' && maxPingTs(next) > maxPingTs(prev)) {
      toast(
        myPlayer()?.role === 'hider'
          ? "📡 Votre position vient d'être envoyée aux hunters"
          : '📡 Nouveaux pings des hiders'
      );
      buzz(200);
    }
    if (prev && prev.round !== next.round) hideResult = false;

    pushPosition(true);
    holdScreen();
    render();
  }

  function render() {
    const screen = !state ? 'home' : state.status === 'lobby' ? 'lobby' : 'game';
    for (const id of ['home', 'lobby', 'game']) $(id).hidden = id !== screen;
    if (screen === 'lobby') renderLobby();
    if (screen === 'game') renderGame();
  }

  // ───────────── Cartes ─────────────

  const ZONE_STYLE = { color: '#ff5d5d', weight: 2, dashArray: '8 6', fillColor: '#ff5d5d', fillOpacity: 0.06 };

  function newMap(id, { zoom = true } = {}) {
    const map = L.map(id, { zoomControl: zoom, tap: true }).setView([46.6, 2.5], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    return map;
  }

  // ───────────── Accueil ─────────────

  $('name').value = read(NAME_KEY) || '';
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) {
    $('code').value = urlCode.toUpperCase().slice(0, 4);
    history.replaceState(null, '', location.pathname);
  }
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone) $('ios-hint').hidden = false;

  function enter(type) {
    const name = $('name').value.trim();
    if (!name) return toast('Entrez votre pseudo.');
    const code = $('code').value.trim().toUpperCase();
    if (type === 'join' && code.length !== 4) return toast('Entrez le code à 4 lettres.');
    write(NAME_KEY, name);
    session = null;
    write(SESSION_KEY, null);
    send({ type, name, code });
  }

  $('home-form').addEventListener('submit', (e) => {
    e.preventDefault();
    enter($('code').value.trim().length === 4 ? 'join' : 'create');
  });
  $('btn-join').addEventListener('click', () => enter('join'));

  // ───────────── Salon ─────────────

  let lmap = null;
  let lCircle = null;
  let lKey = null;
  let draggingRadius = false;
  let radiusTimer = 0;

  function ensureLobbyMap() {
    if (lmap) return;
    lmap = newMap('lobby-map');
    lmap.on('click', (e) => {
      if (!isHost()) return;
      const city = state.settings.city;
      send({
        type: 'settings',
        patch: { city: { name: city?.name ?? 'Zone choisie', lat: e.latlng.lat, lng: e.latlng.lng } },
      });
    });
  }

  function renderLobby() {
    const st = state;
    const host = isHost();
    const s = st.settings;
    const me = myPlayer();

    $('lobby-code').textContent = st.code;
    $('round-label').textContent = `Manche ${st.round + 1}`;
    $('player-count').textContent = `(${st.players.length})`;
    $('player-list').replaceChildren(
      ...st.players.map((p) =>
        h(
          'li',
          {},
          h('span', { class: 'dot' + (p.online ? '' : ' off') }),
          h('span', { class: 'name' + (p.id === st.me ? ' you' : '') }, p.name),
          p.id === st.hostId && h('span', { class: 'chip host' }, 'Hôte'),
          p.role && h('span', { class: `chip ${p.role}` }, roleLabel(p.role))
        )
      )
    );
    $('roles-hint').textContent = me?.role
      ? `Les rôles ont été inversés : vous serez ${roleLabel(me.role).toLowerCase()} cette manche.`
      : 'Les rôles sont tirés au sort au lancement : moitié hiders, moitié hunters.';

    $('city-name').textContent = s.city ? s.city.name : 'Aucune ville choisie';
    $('city-name').classList.toggle('empty', !s.city);
    $('host-search').hidden = !host;
    $('map-hint').hidden = !host;

    const radius = $('radius');
    radius.disabled = !host;
    if (!draggingRadius) {
      radius.value = String(s.radius / 1000);
      $('radius-val').textContent = `${(s.radius / 1000).toFixed(1).replace('.', ',')} km`;
    }

    for (const [id, v] of [['set-head', s.headStartMin], ['set-ping', s.pingEveryMin]]) {
      const el = $(id);
      el.disabled = !host;
      if (document.activeElement !== el) el.value = String(v);
    }
    $('set-see').disabled = !host;
    $('set-see').checked = s.hidersSeeHiders;

    $('btn-start').hidden = !host;
    $('btn-start').disabled = st.players.length < 2 || !s.city;
    $('start-hint').textContent = !host
      ? "En attente du lancement par l'hôte…"
      : !s.city
        ? 'Choisissez une ville pour lancer.'
        : st.players.length < 2
          ? 'Invitez au moins un autre joueur.'
          : '';

    renderGeo();
    ensureLobbyMap();
    lmap.invalidateSize();
    updateLobbyMap();
  }

  function updateLobbyMap() {
    const { city, radius } = state.settings;
    if (!city) {
      lCircle?.remove();
      lCircle = null;
      lKey = null;
      return;
    }
    const center = [city.lat, city.lng];
    if (!lCircle) lCircle = L.circle(center, { ...ZONE_STYLE, radius }).addTo(lmap);
    else if (!draggingRadius) lCircle.setLatLng(center).setRadius(radius);
    const key = `${city.lat},${city.lng},${radius}`;
    if (key !== lKey && !draggingRadius) {
      lKey = key;
      lmap.fitBounds(lCircle.getBounds(), { padding: [12, 12], animate: false });
    }
  }

  $('radius').addEventListener('input', (e) => {
    if (!isHost()) return;
    draggingRadius = true;
    const metres = Math.round(Number(e.target.value) * 1000);
    $('radius-val').textContent = `${(metres / 1000).toFixed(1).replace('.', ',')} km`;
    lCircle?.setRadius(metres);
    clearTimeout(radiusTimer);
    radiusTimer = setTimeout(() => send({ type: 'settings', patch: { radius: metres } }), 250);
  });
  $('radius').addEventListener('change', (e) => {
    clearTimeout(radiusTimer);
    draggingRadius = false;
    send({ type: 'settings', patch: { radius: Math.round(Number(e.target.value) * 1000) } });
  });

  $('set-head').addEventListener('change', (e) =>
    send({ type: 'settings', patch: { headStartMin: Number(e.target.value) } })
  );
  $('set-ping').addEventListener('change', (e) =>
    send({ type: 'settings', patch: { pingEveryMin: Number(e.target.value) } })
  );
  $('set-see').addEventListener('change', (e) =>
    send({ type: 'settings', patch: { hidersSeeHiders: e.target.checked } })
  );

  // Recherche de ville (Nominatim) : une requête par validation, jamais à la frappe.
  $('city-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('city-q').value.trim();
    if (!q) return;
    const list = $('city-results');
    list.replaceChildren(h('li', { class: 'info' }, 'Recherche…'));
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=fr&q=${encodeURIComponent(q)}`
      );
      if (!res.ok) throw new Error(res.status);
      const found = await res.json();
      if (!found.length) return list.replaceChildren(h('li', { class: 'info' }, 'Aucun résultat.'));
      list.replaceChildren(
        ...found.map((it) =>
          h('li', { onclick: () => pickCity(it) }, it.display_name)
        )
      );
    } catch {
      list.replaceChildren(h('li', { class: 'info' }, 'Recherche impossible. Réessayez.'));
    }
  });

  function pickCity(it) {
    const lat = Number(it.lat);
    const lng = Number(it.lon);
    let radius = 5000;
    if (Array.isArray(it.boundingbox)) {
      const [s, n, w, e] = it.boundingbox.map(Number);
      const tall = (n - s) * 111320;
      const wide = (e - w) * 111320 * Math.cos((lat * Math.PI) / 180);
      radius = clamp(Math.round(Math.max(tall, wide) / 2 / 100) * 100, 1000, 25000);
    }
    const name = it.name || it.display_name.split(',')[0];
    send({ type: 'settings', patch: { city: { name, lat, lng }, radius } });
    $('city-results').replaceChildren();
    $('city-q').value = '';
  }

  $('btn-use-pos').addEventListener('click', () => {
    if (!geo.pos) {
      startGeo();
      return toast("Position indisponible pour l'instant.");
    }
    send({ type: 'settings', patch: { city: { name: 'Ma position', lat: geo.pos.lat, lng: geo.pos.lng } } });
  });

  $('btn-geo').addEventListener('click', () => {
    if (geo.watchId !== null) {
      navigator.geolocation.clearWatch(geo.watchId);
      geo.watchId = null;
    }
    startGeo();
  });

  $('btn-share').addEventListener('click', async () => {
    const url = `${location.origin}/?code=${state.code}`;
    const text = `Rejoins ma partie de Manhunt ! Code : ${state.code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Manhunt', text, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Lien copié.');
    } catch {
      toast(`Code de la partie : ${state.code}`);
    }
  });

  $('btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('btn-leave').addEventListener('click', leave);

  // ───────────── Partie ─────────────

  let gmap = null;
  let gCircle = null;
  let meMarker = null;
  let meAcc = null;
  let fittedRound = 0;
  const pins = new Map(); // id -> { marker, em, ping }

  function ensureGameMap() {
    if (gmap) return;
    gmap = newMap('game-map', { zoom: false });
    gCircle = null;
  }

  function renderGame() {
    ensureGameMap();
    gmap.invalidateSize();
    const st = state;
    const s = st.settings;
    if (s.city) {
      const center = [s.city.lat, s.city.lng];
      if (!gCircle) gCircle = L.circle(center, { ...ZONE_STYLE, radius: s.radius, interactive: false }).addTo(gmap);
      else gCircle.setLatLng(center).setRadius(s.radius);
      if (fittedRound !== st.round) {
        fittedRound = st.round;
        gmap.fitBounds(gCircle.getBounds(), { padding: [20, 20], animate: false });
      }
    }
    updateMe();
    syncPins();
    renderSheet();
    renderResult();
    tickUI();
  }

  function updateMe() {
    if (!gmap || !geo.pos) return;
    const ll = [geo.pos.lat, geo.pos.lng];
    if (!meMarker) {
      meAcc = L.circle(ll, { radius: geo.pos.acc, color: '#4ea1ff', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(gmap);
      meMarker = L.circleMarker(ll, {
        radius: 8,
        color: '#fff',
        weight: 3,
        fillColor: '#4ea1ff',
        fillOpacity: 1,
        interactive: false,
      }).addTo(gmap);
    } else {
      meMarker.setLatLng(ll);
      meAcc.setLatLng(ll).setRadius(geo.pos.acc);
    }
  }

  function popupFor(id) {
    const p = state.players.find((x) => x.id === id);
    const e = pins.get(id);
    if (!p || !e) return h('div');
    const me = myPlayer();
    const canCatch = state.status === 'running' && me.role === 'hunter' && !p.caught && now() >= state.releaseAt;
    return h(
      'div',
      { class: 'popup-body' },
      h('b', {}, id === state.me ? 'Mon dernier ping' : p.name),
      h('span', { class: 'muted' }, `Ping ${ageText(now() - e.ping.ts)}`),
      canCatch &&
        h(
          'button',
          {
            class: 'btn danger',
            onclick: () => {
              send({ type: 'caught', target: id });
              e.marker.closePopup();
            },
          },
          `${p.name} est attrapé`
        )
    );
  }

  function syncPins() {
    const keep = new Set();
    for (const ping of state.pings) {
      const p = state.players.find((x) => x.id === ping.id);
      if (!p) continue;
      keep.add(ping.id);
      const mine = ping.id === state.me;
      let e = pins.get(ping.id);
      if (!e) {
        const em = h('em');
        const root = h('div', { class: 'pin' }, h('div', { class: 'bubble' }, h('span', {}, ''), em));
        const marker = L.marker([ping.lat, ping.lng], {
          icon: L.divIcon({ className: 'pin-wrap', html: root, iconSize: [0, 0] }),
          keyboard: false,
        }).addTo(gmap);
        marker.bindPopup(() => popupFor(ping.id), { closeButton: false, offset: [0, -34] });
        e = { marker, em, root, ping };
        pins.set(ping.id, e);
      }
      e.ping = ping;
      e.marker.setLatLng([ping.lat, ping.lng]);
      e.root.querySelector('span').textContent = mine ? 'Moi' : p.name;
      e.root.classList.toggle('mine', mine);
      e.root.classList.toggle('ally', !mine && myPlayer().role === 'hider');
      e.root.classList.toggle('stale', ping.ts - ping.fixAt > 120000);
    }
    for (const [id, e] of pins) {
      if (!keep.has(id)) {
        e.marker.remove();
        pins.delete(id);
      }
    }
    updateAges();
  }

  function updateAges() {
    for (const e of pins.values()) e.em.textContent = ageText(now() - e.ping.ts);
  }

  function renderSheet() {
    const st = state;
    const me = myPlayer();
    const running = st.status === 'running';
    const released = running && now() >= st.releaseAt;
    const hiders = st.players.filter((p) => p.role === 'hider');
    const alive = hiders.filter((p) => !p.caught).length;

    $('sheet-summary').textContent =
      st.status === 'ended'
        ? 'Manche terminée'
        : `${alive}/${hiders.length} ${plural(hiders.length, 'hider', 'hiders')} en fuite`;

    $('game-players').replaceChildren(
      ...st.players.map((p) =>
        h(
          'li',
          { class: p.caught ? 'caught' : '' },
          h('span', { class: 'dot' + (p.online ? '' : ' off') }),
          h('span', { class: 'name' + (p.id === st.me ? ' you' : '') }, p.name),
          p.caught && h('span', { class: 'chip ghost' }, 'Attrapé'),
          p.left && h('span', { class: 'chip ghost' }, 'Parti'),
          h('span', { class: `chip ${p.role || ''}` }, roleLabel(p.role)),
          released &&
            me.role === 'hunter' &&
            p.role === 'hider' &&
            !p.caught &&
            h(
              'button',
              {
                class: 'btn small danger',
                style: 'width:auto',
                onclick: () => send({ type: 'caught', target: p.id }),
              },
              'Attrapé'
            )
        )
      )
    );

    $('btn-caught').hidden = !(running && me.role === 'hider' && !me.caught);
    const endBtn = $('btn-end');
    if (st.status === 'ended') {
      endBtn.hidden = false;
      endBtn.textContent = 'Voir les résultats';
    } else {
      endBtn.hidden = !(running && isHost());
      endBtn.textContent = 'Terminer la partie';
    }
  }

  function renderResult() {
    const st = state;
    const show = st.status === 'ended' && !hideResult;
    $('result').hidden = !show;
    if (!show) return;

    const me = myPlayer();
    const hidersWon = !st.allCaught;
    const won = (me.role === 'hider') === hidersWon;
    const base = st.releaseAt;
    const survived = (p) => Math.max(0, (p.caughtAt ?? st.endedAt) - base);
    const hiders = st.players.filter((p) => p.role === 'hider').sort((a, b) => survived(b) - survived(a));

    $('result-emoji').textContent = won ? '🏆' : '💀';
    $('result-title').textContent = won ? 'Victoire !' : 'Défaite';
    $('result-sub').textContent = st.allCaught
      ? `Les hunters ont attrapé tous les hiders en ${fmt(Math.max(0, st.endedAt - base))}.`
      : 'Des hiders sont restés introuvables : victoire des hiders.';
    $('result-list').replaceChildren(
      ...hiders.map((p) =>
        h(
          'li',
          {},
          p.name,
          h('span', { class: 'time' }, p.caught ? fmt(survived(p)) : `${fmt(survived(p))} · non attrapé`)
        )
      )
    );

    const next = me.role === 'hider' ? 'hunter' : 'hider';
    $('btn-next').hidden = !isHost();
    $('next-hint').textContent = isHost()
      ? `Les rôles s'inversent : vous serez ${next}.`
      : `En attente de l'hôte pour la manche suivante. Vous serez ${next}.`;
  }

  // Compte à rebours, âge des pings, alertes de zone : recalculés chaque seconde.
  function tickUI() {
    if (!state || state.status === 'lobby') return;
    const st = state;
    const t = now();
    const me = myPlayer();
    if (!me) return;

    const chip = $('role-chip');
    chip.textContent = roleLabel(me.role).toUpperCase();
    chip.className = `chip ${me.role || ''}`;
    $('round-chip').textContent = `Manche ${st.round}`;

    const hiders = st.players.filter((p) => p.role === 'hider');
    const alive = hiders.filter((p) => !p.caught).length;
    const mine = st.pings.find((p) => p.id === st.me);
    let title = '';
    let time = '';
    let sub = '';

    if (st.status === 'ended') {
      title = 'Manche terminée';
      time = '🏁';
    } else if (me.role === 'hider' && me.caught) {
      title = 'Vous avez été attrapé';
      time = '😵';
      sub = 'Vous suivez la fin de la manche en spectateur.';
    } else if (t < st.releaseAt) {
      time = fmt(st.releaseAt - t);
      if (me.role === 'hider') {
        title = 'Cachez-vous ! Les hunters sont lâchés dans';
        sub = 'Le premier ping partira à leur départ.';
      } else {
        title = 'Ne bougez pas ! Départ dans';
        sub = 'Les hiders sont en train de se cacher…';
      }
    } else {
      time = fmt(st.nextPingAt - t);
      if (me.role === 'hider') {
        title = 'Prochain ping de votre position dans';
        sub = mine ? `Dernier ping : ${ageText(t - mine.ts)}` : 'Aucun ping envoyé pour le moment.';
      } else {
        title = 'Prochain ping des hiders dans';
        sub = `${alive} ${plural(alive, 'hider reste', 'hiders restent')} en fuite`;
      }
    }
    $('phase-title').textContent = title;
    $('phase-time').textContent = time;
    $('phase-sub').textContent = sub;

    updateAges();
    updateWarn();
  }
  setInterval(tickUI, 1000);

  function updateWarn() {
    const el = $('warn');
    if (!state || state.status !== 'running') {
      el.hidden = true;
      return;
    }
    const city = state.settings.city;
    let msg = '';
    let info = false;
    if (geo.status === 'denied' || geo.status === 'unsupported') {
      msg = 'Localisation indisponible : autorisez-la pour jouer.';
    } else if (geo.pos && city && distance(geo.pos, city) > state.settings.radius) {
      msg = '⚠️ Vous êtes hors de la zone de jeu !';
    } else if (!geo.pos) {
      msg = 'Recherche de votre position…';
      info = true;
    }
    el.hidden = !msg;
    el.textContent = msg;
    el.classList.toggle('info', info);
  }

  $('sheet-handle').addEventListener('click', () => $('sheet').classList.toggle('collapsed'));

  $('btn-caught').addEventListener('click', () => {
    if (confirm('Confirmer : vous avez été attrapé ?')) send({ type: 'caught' });
  });

  $('btn-end').addEventListener('click', () => {
    if (state.status === 'ended') {
      hideResult = false;
      return renderResult();
    }
    if (confirm('Terminer la manche pour tout le monde ?')) send({ type: 'end' });
  });

  $('btn-next').addEventListener('click', () => send({ type: 'next' }));
  $('btn-map').addEventListener('click', () => {
    hideResult = true;
    renderResult();
  });
  $('btn-quit').addEventListener('click', leave);
  $('btn-leave-game').addEventListener('click', () => {
    if (confirm('Quitter la partie ? Un hider qui part est considéré comme attrapé.')) leave();
  });

  $('btn-me').addEventListener('click', () => {
    if (!geo.pos) return toast("Position indisponible pour l'instant.");
    gmap.setView([geo.pos.lat, geo.pos.lng], Math.max(gmap.getZoom(), 16));
  });
  $('btn-zone').addEventListener('click', () => {
    if (gCircle) gmap.fitBounds(gCircle.getBounds(), { padding: [20, 20] });
  });

  // ───────────── Démarrage ─────────────

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state) holdScreen();
    if (session && (!ws || ws.readyState > 1)) connect();
    tickUI();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  render();
  if (session) {
    connect();
    startGeo();
  }
})();
