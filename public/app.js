(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
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

  // ───────────── Dessins ─────────────

  const ICON = {
    soundOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/></svg>',
    dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    crown: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>',
  };

  const GHOST = (cls = 'gbody') =>
    `<svg class="${cls}" viewBox="0 0 30 34" aria-hidden="true"><path fill="currentColor" d="M15 1C7.3 1 2 6.6 2 14v18.5l4.3-3 4.3 3 4.4-3 4.4 3 4.3-3 4.3 3V14C28 6.6 22.7 1 15 1z"/><ellipse cx="10.5" cy="14" rx="2.4" ry="3.2" fill="#0b0910"/><ellipse cx="19.5" cy="14" rx="2.4" ry="3.2" fill="#0b0910"/><ellipse cx="15" cy="22" rx="2" ry="2.6" fill="#0b0910" opacity=".85"/></svg>`;
  const SCOPE =
    '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="24" cy="24" r="16"/><circle cx="24" cy="24" r="7"/><path d="M24 2v10M24 36v10M2 24h10M36 24h10"/></svg>';
  const TOMB =
    '<svg viewBox="0 0 26 30" aria-hidden="true"><path d="M5 28V12a8 8 0 0 1 16 0v16z" fill="#2f2839" stroke="#a196b0" stroke-width="1.5"/><path d="M13 10v9M9.5 13.5h7" stroke="#e6dcef" stroke-width="2" stroke-linecap="round"/><path d="M2 28.5h22" stroke="#6f6680" stroke-width="2" stroke-linecap="round"/></svg>';
  const CROWN_ART =
    '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 17l9 8 9-14 9 14 9-8-4 21H10z" fill="rgba(255,231,168,.16)" stroke="#ffe7a8" stroke-width="2.6" stroke-linejoin="round"/><circle cx="24" cy="30" r="2.6" fill="#ff7a1a"/></svg>';
  const MOON_ART =
    '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="result-moon"><rect width="48" height="48" fill="#fff"/><circle cx="31" cy="17" r="14" fill="#000"/></mask></defs><circle cx="22" cy="26" r="17" fill="#f4e4c1" mask="url(#result-moon)"/></svg>';

  // ───────────── Stockage local ─────────────

  const SESSION_KEY = 'manhunt.session';
  const NAME_KEY = 'manhunt.name';
  const SOUND_KEY = 'manhunt.sound';
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

  // ───────────── Retours : toast, vibration, sons ─────────────

  let toastTimer;
  function toast(msg, kind = '') {
    const t = $('toast');
    t.textContent = msg;
    t.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = kind), 3600);
  }

  const buzz = (pattern) => {
    try {
      navigator.vibrate?.(pattern);
    } catch {}
  };

  // Sons synthétisés à la volée (Web Audio) : rien à télécharger.
  const sfx = (() => {
    let ctx = null;
    let on = read(SOUND_KEY) !== 'off';

    function unlock() {
      if (!on) return null;
      if (!ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        ctx = new Ctx();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    window.addEventListener('pointerdown', unlock, { passive: true });

    function tone({ type = 'sine', from, to = from, dur = 0.3, gain = 0.15, delay = 0 }) {
      const a = unlock();
      if (!a) return;
      const t = a.currentTime + delay;
      const osc = a.createOscillator();
      const amp = a.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + dur);
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.exponentialRampToValueAtTime(gain, t + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(amp).connect(a.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }

    const sounds = {
      ping() {
        tone({ from: 1180, to: 1040, dur: 0.9, gain: 0.16 });
        tone({ from: 1180, to: 1040, dur: 0.9, gain: 0.05, delay: 0.38 });
      },
      start() {
        tone({ from: 70, to: 45, dur: 1.4, gain: 0.35 });
        tone({ type: 'triangle', from: 220, to: 110, dur: 1.1, gain: 0.12 });
        tone({ type: 'triangle', from: 233, to: 116, dur: 1.1, gain: 0.08, delay: 0.05 });
      },
      release() {
        tone({ type: 'sawtooth', from: 140, to: 420, dur: 1.2, gain: 0.06 });
        tone({ type: 'sawtooth', from: 147, to: 440, dur: 1.2, gain: 0.045 });
        tone({ from: 60, to: 40, dur: 1.6, gain: 0.35, delay: 0.9 });
      },
      caught() {
        tone({ from: 160, to: 40, dur: 0.6, gain: 0.4 });
        tone({ type: 'square', from: 90, to: 60, dur: 0.25, gain: 0.04 });
      },
      alarm() {
        for (let i = 0; i < 4; i++) tone({ type: 'square', from: i % 2 ? 660 : 880, dur: 0.14, gain: 0.05, delay: i * 0.18 });
      },
      tick() {
        tone({ from: 1500, to: 1400, dur: 0.06, gain: 0.04 });
      },
      msg() {
        tone({ from: 700, to: 1050, dur: 0.12, gain: 0.07 });
        tone({ from: 1050, to: 1400, dur: 0.1, gain: 0.04, delay: 0.09 });
      },
      win() {
        [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', from: f, dur: 0.5, gain: 0.12, delay: i * 0.12 }));
      },
      lose() {
        [392, 330, 262, 196].forEach((f, i) => tone({ type: 'triangle', from: f, to: f * 0.97, dur: 0.6, gain: 0.1, delay: i * 0.18 }));
      },
    };

    return {
      play(name) {
        if (!on) return;
        try {
          sounds[name]?.();
        } catch {}
      },
      get on() {
        return on;
      },
      toggle() {
        on = !on;
        write(SOUND_KEY, on ? null : 'off');
        return on;
      },
    };
  })();

  function renderSound() {
    for (const b of document.querySelectorAll('.sound-btn')) {
      b.innerHTML = sfx.on ? ICON.soundOn : ICON.soundOff;
      b.setAttribute('aria-label', sfx.on ? 'Couper le son' : 'Activer le son');
    }
  }
  for (const b of document.querySelectorAll('.sound-btn')) {
    b.addEventListener('click', () => {
      const on = sfx.toggle();
      renderSound();
      toast(on ? 'Son activé' : 'Son coupé');
      if (on) sfx.play('msg');
    });
  }

  // Fenêtre de choix, à la place de confirm() : renvoie la valeur du bouton touché (null si on ferme).
  function ask({ title, text = '', actions }) {
    return new Promise((resolve) => {
      const modal = $('modal');
      const close = (v) => {
        modal.hidden = true;
        modal.onclick = null;
        resolve(v);
      };
      $('modal-title').textContent = title;
      $('modal-text').textContent = text;
      $('modal-text').hidden = !text;
      $('modal-actions').replaceChildren(
        ...actions.map((a) => h('button', { type: 'button', class: `btn ${a.cls || ''}`, onclick: () => close(a.value) }, a.label))
      );
      modal.onclick = (e) => {
        if (e.target === modal) close(null);
      };
      modal.hidden = false;
    });
  }

  const confirmAsk = (title, text, yes, cls = 'primary') =>
    ask({ title, text, actions: [{ label: yes, value: true, cls }, { label: 'Annuler', value: false, cls: 'ghost' }] });

  // ───────────── Session et connexion ─────────────

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

  function clock(ts) {
    const d = new Date(ts - clockOffset);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

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
      case 'kicked':
        clearSession();
        toast("L'hôte t'a exclu de la partie.", 'alert');
        break;
      case 'error':
        toast(m.message, 'alert');
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
    fittedRound = 0;
    seenChat = 0;
    unread = 0;
    lastTick = 0;
    seenRows.clear();
    $('modal').hidden = true;
    render();
  }

  function leave() {
    sendLive({ type: 'leave' });
    clearSession();
  }

  // ───────────── Localisation ─────────────

  const geo = { status: 'idle', pos: null, out: false, watchId: null, lastSent: 0 };

  function isOut(pos) {
    const city = state?.settings.city;
    if (!pos || !city) return false;
    return distance(pos, city) > state.settings.radius + Math.min(pos.acc ?? 0, 40);
  }

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
    geo.out = false;
    geo.status = 'idle';
  }

  function onPosition(p) {
    geo.status = 'ok';
    geo.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    const wasOut = geo.out;
    geo.out = isOut(geo.pos);
    pushPosition(wasOut !== geo.out);
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

  // Le serveur garde la dernière position et ne la diffuse qu'aux pings, ou en continu
  // pour un hider resté trop longtemps hors zone. Les hunters n'envoient pas la leur.
  function pushPosition(force) {
    const me = myPlayer();
    if (!geo.pos || !state || me?.role === 'hunter' || me?.caught) return;
    const t = Date.now();
    if (!force && t - geo.lastSent < (geo.out ? 2500 : 8000)) return;
    geo.lastSent = t;
    sendLive({ type: 'pos', lat: geo.pos.lat, lng: geo.pos.lng, acc: geo.pos.acc });
  }
  setInterval(() => pushPosition(), 2500);

  function renderGeo() {
    const msgs = {
      idle: '',
      wait: 'Recherche de ta position…',
      ok: 'Position détectée.',
      denied: 'Localisation refusée. Autorise-la dans les réglages du navigateur, puis touche le bouton.',
      unsupported: 'Ton navigateur ne gère pas la géolocalisation : impossible de jouer.',
    };
    $('geo-status').textContent = msgs[geo.status];
    $('geo-card').hidden = geo.status === 'ok' || geo.status === 'idle';
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
  const nameOf = (id) => state?.players.find((p) => p.id === id)?.name ?? '?';

  function outcome(st = state) {
    if (st.endReason === 'host') return 'draw';
    const hidersWon = !st.allCaught;
    return (myPlayer()?.role === 'hider') === hidersWon ? 'win' : 'lose';
  }

  function applyState(next) {
    const prev = state;
    state = next;
    clockOffset = next.now - Date.now();
    const me = myPlayer();
    if (!me) return clearSession();

    if (prev?.status !== next.status) {
      hideResult = false;
      if (next.status === 'running' && next.now - next.startedAt < 8000) roleSplash();
      if (next.status === 'ended' && prev?.status === 'running') {
        const res = outcome(next);
        sfx.play(res === 'win' ? 'win' : res === 'lose' ? 'lose' : 'caught');
        buzz([300, 100, 300]);
      }
      if (next.status === 'final' && prev) sfx.play('win');
    }

    if (prev?.status === 'running' && next.status === 'running') {
      if (next.nextPingAt !== prev.nextPingAt && Math.abs(now() - next.releaseAt) > 3000) {
        toast(me.role === 'hider' ? 'Ta position vient de partir chez les hunters' : 'Nouveaux pings des hiders');
        sfx.play('ping');
        buzz(200);
      }
      for (const p of next.players) {
        const before = prev.players.find((x) => x.id === p.id);
        if (!before) continue;
        if (p.exposed && !before.exposed) {
          if (p.id === me.id) {
            sfx.play('alarm');
            buzz([200, 100, 200, 100, 400]);
          } else if (me.role === 'hunter') {
            toast(`${p.name} a quitté la zone : position révélée !`, 'alert');
            sfx.play('alarm');
          }
        }
        if (p.caught && !before.caught && !p.left) {
          toast(p.id === me.id ? "Tu t'es fait attraper…" : `${p.name} s'est fait attraper !`, p.id === me.id ? 'alert' : 'good');
          sfx.play('caught');
          buzz(400);
        }
        if (p.left && !before.left) toast(`${p.name} a quitté la partie.`);
      }
    }

    const fresh = next.chat.filter((m) => m.id > seenChat && m.from !== next.me);
    // Les messages d'équipe révélés en fin de manche arrivent en silence.
    if (prev && fresh.length && next.status !== 'lobby' && prev.status === next.status) {
      if (!chatOpen()) {
        unread += fresh.length;
        const last = fresh[fresh.length - 1];
        toast(`${last.name} : ${last.text}`);
      }
      sfx.play('msg');
    }
    seenChat = next.chat.reduce((m, x) => Math.max(m, x.id), seenChat);
    if (prev && prev.round !== next.round) hideResult = false;

    pushPosition();
    holdScreen();
    render();
  }

  function render() {
    const screen = !state ? 'home' : state.status === 'lobby' ? 'lobby' : state.status === 'final' ? 'final' : 'game';
    for (const id of ['home', 'lobby', 'game', 'final']) $(id).hidden = id !== screen;
    renderSound();
    if (screen === 'lobby') renderLobby();
    if (screen === 'game') renderGame();
    if (screen === 'final') renderFinal();
  }

  // ───────────── Joueurs et classements ─────────────

  const seenRows = new Set(); // pour n'animer que les nouveaux venus

  // Fantôme pour un hider, viseur pour un hunter, rond vide tant que le rôle n'est pas connu.
  function glyph(p) {
    const art = p.role === 'hider' ? GHOST('') : p.role === 'hunter' ? SCOPE : '';
    return h('span', { class: `who-glyph ${p.role || ''}`, html: art });
  }

  function nameLine(p) {
    return h(
      'div',
      { class: 'pname' },
      h('span', {}, p.name),
      p.id === state.me && h('span', { class: 'you' }, '(toi)'),
      p.id === state.hostId && h('span', { html: ICON.crown, title: 'Hôte' })
    );
  }

  function playerRow(p, { meta = '', alert = false, actions = [] } = {}) {
    const li = h(
      'li',
      { class: `${p.caught ? 'caught' : ''} ${p.online ? '' : 'off'}` },
      glyph(p),
      h('div', { class: 'pmain' }, nameLine(p), meta && h('div', { class: `pmeta${alert ? ' alert' : ''}` }, meta)),
      ...actions
    );
    if (!seenRows.has(p.id)) {
      seenRows.add(p.id);
      li.classList.add('enter');
    }
    return li;
  }

  function moreBtn(p) {
    return h('button', {
      type: 'button',
      class: 'more',
      'aria-label': `Options pour ${p.name}`,
      html: ICON.dots,
      onclick: () => playerMenu(p),
    });
  }

  async function playerMenu(p) {
    const v = await ask({
      title: p.name,
      actions: [
        { label: "Lui passer le rôle d'hôte", value: 'host' },
        { label: 'Exclure de la partie', value: 'kick', cls: 'danger' },
        { label: 'Annuler', value: null, cls: 'ghost' },
      ],
    });
    if (v === 'host') send({ type: 'host', target: p.id });
    if (v === 'kick') {
      const running = state?.status === 'running';
      const sure = await confirmAsk(
        `Exclure ${p.name} ?`,
        running && p.role === 'hider' ? 'Un hider exclu compte comme un abandon.' : 'Il pourra revenir avec le code tant que la manche n’a pas commencé.',
        'Exclure',
        'danger'
      );
      if (sure) send({ type: 'kick', target: p.id });
    }
  }

  const ranked = (st) => st.players.filter((p) => !p.left).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  function boardRows(list, offset = 0) {
    return list.map((p, i) => {
      const rank = offset + i + 1;
      const gain = state.lastRound?.[p.id]?.pts;
      return h(
        'li',
        { class: rank <= 3 ? `r${rank}` : '' },
        h('span', { class: 'rank' }, String(rank)),
        nameLine(p),
        h('div', { class: 'pts' }, String(p.score), gain ? h('small', {}, `+${gain}`) : null)
      );
    });
  }

  // ───────────── Cartes ─────────────

  const ZONE = '#ff7a1a';
  const WORLD = [
    [-89.9, -360],
    [-89.9, 360],
    [89.9, 360],
    [89.9, -360],
  ];

  function newMap(id, { zoom = true } = {}) {
    const map = L.map(id, { zoomControl: zoom }).setView([46.6, 2.5], 5);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    // Tuiles OpenStreetMap, passées en mode nuit par un filtre CSS (voir .leaflet-tile-pane).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    return map;
  }

  // Cercle de la zone en coordonnées, pour assombrir tout ce qui est dehors.
  function ring(c, r, n = 96) {
    const rad = Math.PI / 180;
    const d = r / 6371000;
    const lat1 = c.lat * rad;
    const lng1 = c.lng * rad;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const b = (2 * Math.PI * i) / n;
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
      const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
      pts.push([lat2 / rad, lng2 / rad]);
    }
    return pts;
  }

  function drawZone(map, zone, city, radius) {
    const center = [city.lat, city.lng];
    if (!zone) {
      zone = {
        mask: L.polygon([WORLD, ring(city, radius)], { stroke: false, fillColor: '#05030a', fillOpacity: 0.55, interactive: false }),
        glow: L.circle(center, { radius, color: ZONE, weight: 12, opacity: 0.14, fill: false, interactive: false }),
        edge: L.circle(center, { radius, color: ZONE, weight: 2.5, opacity: 0.95, dashArray: '2 9', lineCap: 'round', fill: false, interactive: false }),
      };
      for (const layer of Object.values(zone)) layer.addTo(map);
      return zone;
    }
    zone.mask.setLatLngs([WORLD, ring(city, radius)]);
    zone.glow.setLatLng(center).setRadius(radius);
    zone.edge.setLatLng(center).setRadius(radius);
    return zone;
  }

  function removeZone(zone) {
    if (zone) for (const layer of Object.values(zone)) layer.remove();
    return null;
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
    if (!name) return toast('Entre ton pseudo.');
    const code = $('code').value.trim().toUpperCase();
    if (type === 'join' && code.length !== 4) return toast('Entre le code à 4 lettres.');
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
  let lZone = null;
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

  function roleSeg(p) {
    return h(
      'div',
      { class: 'seg mini' },
      ['hider', 'hunter'].map((r) =>
        h(
          'button',
          {
            type: 'button',
            'data-v': r,
            class: p.role === r ? 'on' : '',
            onclick: () => send({ type: 'role', target: p.id, role: p.role === r ? null : r }),
          },
          roleLabel(r)
        )
      )
    );
  }

  const MODE_HINTS = {
    swap: (s) =>
      s.hunterCount
        ? 'Chacun passe hunter à son tour, manche après manche.'
        : 'Les hunters deviennent hiders à la manche suivante, et inversement.',
    random: () => 'Nouveau tirage au sort à chaque manche.',
    manual: () => "L'hôte place chaque joueur lui-même.",
  };

  function renderLobby() {
    const st = state;
    const host = isHost();
    const s = st.settings;
    const me = myPlayer();
    const manual = s.roleMode === 'manual';

    $('lobby-code').textContent = st.code;
    $('round-label').textContent = `Manche ${st.round + 1}`;
    $('player-count').textContent = String(st.players.length);
    $('player-list').replaceChildren(
      ...st.players.map((p) => {
        const actions = [];
        if (manual && host) actions.push(roleSeg(p));
        else if (p.role) actions.push(h('span', { class: `tag ${p.role}` }, roleLabel(p.role)));
        if (host && p.id !== st.me) actions.push(moreBtn(p));
        const meta = !p.online ? 'hors ligne' : st.round > 0 ? `${p.score} pts` : '';
        return playerRow(p, { meta, actions });
      })
    );

    const n = st.players.length;
    let compo = '';
    if (manual) {
      const hunters = st.players.filter((p) => p.role === 'hunter').length;
      const hiders = st.players.filter((p) => p.role === 'hider').length;
      const loose = n - hunters - hiders;
      compo = `${hunters} ${plural(hunters, 'hunter', 'hunters')}, ${hiders} ${plural(hiders, 'hider', 'hiders')}${loose ? `, ${loose} pas encore ${plural(loose, 'placé', 'placés')}` : ''}.`;
    } else if (n >= 2) {
      const hunters = s.hunterCount ? clamp(s.hunterCount, 1, n - 1) : Math.floor(n / 2);
      compo = `${hunters} ${plural(hunters, 'hunter', 'hunters')} contre ${n - hunters} ${plural(n - hunters, 'hider', 'hiders')}.`;
    }
    const who = manual
      ? host
        ? 'Place chaque joueur ; ceux que tu laisses seront tirés au sort.'
        : "L'hôte compose les équipes."
      : me.role
        ? `Cette manche, tu seras ${me.role}.`
        : 'Rôles tirés au sort au lancement.';
    $('roles-hint').textContent = `${compo} ${who}`.trim();
    $('mode-hint').textContent = MODE_HINTS[s.roleMode](s);

    $('score-block').hidden = st.round === 0;
    if (st.round > 0) {
      $('lobby-board').replaceChildren(...boardRows(ranked(st)));
      $('btn-final').hidden = !host;
    }

    $('city-name').textContent = s.city ? s.city.name : 'Aucune zone choisie';
    $('city-name').classList.toggle('empty', !s.city);
    $('host-search').hidden = !host;
    $('map-hint').hidden = !host;

    const radius = $('radius');
    radius.disabled = !host;
    if (!draggingRadius) {
      radius.value = String(s.radius / 1000);
      $('radius-val').textContent = `${(s.radius / 1000).toFixed(1).replace('.', ',')} km`;
    }
    radiusFill();

    for (const [id, v] of [
      ['set-head', s.headStartMin],
      ['set-ping', s.pingEveryMin],
      ['set-duration', s.durationMin],
      ['set-out', s.outGraceSec],
    ]) {
      const el = $(id);
      el.disabled = !host;
      if (document.activeElement !== el) el.value = String(v);
    }
    $('set-see').disabled = !host;
    $('set-see').checked = s.hidersSeeHiders;
    for (const seg of document.querySelectorAll('#lobby .seg[data-key]')) {
      const v = String(s[seg.dataset.key]);
      seg.classList.toggle('locked', !host);
      for (const b of seg.children) {
        b.classList.toggle('on', b.dataset.v === v);
        b.disabled = !host;
      }
    }

    $('btn-start').hidden = !host;
    $('btn-start').disabled = n < 2 || !s.city;
    $('start-hint').textContent = !host
      ? "En attente du lancement par l'hôte…"
      : !s.city
        ? 'Choisis une zone pour lancer.'
        : n < 2
          ? 'Invite au moins un autre joueur.'
          : '';

    renderGeo();
    ensureLobbyMap();
    lmap.invalidateSize();
    updateLobbyMap();
  }

  function radiusFill() {
    const r = $('radius');
    const pct = ((Number(r.value) - Number(r.min)) / (Number(r.max) - Number(r.min))) * 100;
    r.style.setProperty('--fill', `${pct}%`);
  }

  function updateLobbyMap() {
    const { city, radius } = state.settings;
    if (!city) {
      lZone = removeZone(lZone);
      lKey = null;
      return;
    }
    if (!draggingRadius) lZone = drawZone(lmap, lZone, city, radius);
    const key = `${city.lat},${city.lng},${radius}`;
    if (key !== lKey && !draggingRadius) {
      lKey = key;
      lmap.fitBounds(lZone.edge.getBounds(), { padding: [14, 14], animate: false });
    }
  }

  $('radius').addEventListener('input', (e) => {
    if (!isHost()) return;
    draggingRadius = true;
    const metres = Math.round(Number(e.target.value) * 1000);
    $('radius-val').textContent = `${(metres / 1000).toFixed(1).replace('.', ',')} km`;
    radiusFill();
    if (state.settings.city) lZone = drawZone(lmap, lZone, state.settings.city, metres);
    clearTimeout(radiusTimer);
    radiusTimer = setTimeout(() => send({ type: 'settings', patch: { radius: metres } }), 250);
  });
  $('radius').addEventListener('change', (e) => {
    clearTimeout(radiusTimer);
    draggingRadius = false;
    send({ type: 'settings', patch: { radius: Math.round(Number(e.target.value) * 1000) } });
  });

  for (const [id, key] of [
    ['set-head', 'headStartMin'],
    ['set-ping', 'pingEveryMin'],
    ['set-duration', 'durationMin'],
    ['set-out', 'outGraceSec'],
  ]) {
    $(id).addEventListener('change', (e) => send({ type: 'settings', patch: { [key]: Number(e.target.value) } }));
  }
  $('set-see').addEventListener('change', (e) => send({ type: 'settings', patch: { hidersSeeHiders: e.target.checked } }));
  for (const seg of document.querySelectorAll('.seg[data-key]')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !isHost()) return;
      const v = 'num' in seg.dataset ? Number(b.dataset.v) : b.dataset.v;
      send({ type: 'settings', patch: { [seg.dataset.key]: v } });
    });
  }

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
      list.replaceChildren(...found.map((it) => h('li', { onclick: () => pickCity(it) }, it.display_name)));
    } catch {
      list.replaceChildren(h('li', { class: 'info' }, 'Recherche impossible. Réessaie.'));
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
      toast('Lien copié.', 'good');
    } catch {
      toast(`Code de la partie : ${state.code}`);
    }
  });

  $('btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('btn-leave').addEventListener('click', leave);
  async function askFinal() {
    if (await confirmAsk('Fin de soirée ?', 'On affiche le podium avec les scores cumulés de toutes les manches.', 'Voir le podium')) {
      send({ type: 'final' });
    }
  }
  $('btn-final').addEventListener('click', askFinal);

  // ───────────── Partie ─────────────

  let gmap = null;
  let gZone = null;
  let meMarker = null;
  let meAcc = null;
  let fittedRound = 0;
  let sheetTab = 'players';
  let chatCh = 'team';
  let unread = 0;
  let seenChat = 0;
  let lastTick = 0;
  let lastWarnSec = null;
  const pins = new Map(); // id -> { marker, root, name, em, ping }
  const tombs = new Map(); // id -> marker

  function ensureGameMap() {
    if (gmap) return;
    gmap = newMap('game-map', { zoom: false });
  }

  function fitZone(animate) {
    if (!gZone) return;
    gmap.fitBounds(gZone.edge.getBounds(), { paddingTopLeft: [20, 200], paddingBottomRight: [20, 90], animate });
  }

  function renderGame() {
    ensureGameMap();
    gmap.invalidateSize();
    const st = state;
    const s = st.settings;
    $('game').dataset.role = myPlayer().role || '';
    if (s.city) {
      gZone = drawZone(gmap, gZone, s.city, s.radius);
      if (fittedRound !== st.round) {
        fittedRound = st.round;
        fitZone(false);
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
      meAcc = L.circle(ll, { radius: geo.pos.acc, color: '#ffe7a8', weight: 1, opacity: 0.4, fillOpacity: 0.06, interactive: false }).addTo(gmap);
      meMarker = L.marker(ll, {
        icon: L.divIcon({ className: 'pin-wrap', html: h('div', { class: 'me-dot' }), iconSize: [0, 0] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
      }).addTo(gmap);
    } else {
      meMarker.setLatLng(ll);
      meAcc.setLatLng(ll).setRadius(geo.pos.acc);
    }
  }

  async function catchPlayer(p) {
    if (await confirmAsk(`${p.name} attrapé ?`, 'La capture compte pour toi.', 'Oui, attrapé !')) {
      send({ type: 'caught', target: p.id });
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
      h('span', {}, e.ping.out ? 'Hors zone, suivi en direct' : `Ping ${ageText(now() - e.ping.ts)}`),
      canCatch &&
        h(
          'button',
          {
            type: 'button',
            class: 'btn danger',
            onclick: () => {
              e.marker.closePopup();
              catchPlayer(p);
            },
          },
          'Attrapé !'
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
      const isNew = !e;
      if (!e) {
        const name = h('span');
        const em = h('em');
        const root = h(
          'div',
          { class: 'ghost-pin' },
          h('div', { class: 'label' }, name, em),
          h('div', { html: GHOST() }),
          h('span', { class: 'ripple' })
        );
        const marker = L.marker([ping.lat, ping.lng], {
          icon: L.divIcon({ className: 'pin-wrap', html: root, iconSize: [0, 0] }),
          keyboard: false,
        }).addTo(gmap);
        marker.bindPopup(() => popupFor(ping.id), { closeButton: false, offset: [0, -72] });
        e = { marker, root, name, em, ping };
        pins.set(ping.id, e);
      }
      const freshPing = isNew || (e.ping.ts !== ping.ts && !ping.out);
      e.ping = ping;
      e.marker.setLatLng([ping.lat, ping.lng]);
      e.name.textContent = mine ? 'Moi' : p.name;
      e.root.classList.toggle('mine', mine);
      e.root.classList.toggle('out', ping.out);
      e.root.classList.toggle('stale', !ping.out && ping.ts - ping.fixAt > 90000);
      if (freshPing) {
        e.root.classList.remove('fresh');
        void e.root.offsetWidth;
        e.root.classList.add('fresh');
      }
    }
    for (const [id, e] of pins) {
      if (!keep.has(id)) {
        e.marker.remove();
        pins.delete(id);
      }
    }
    updateAges();
    syncTombs();
  }

  // Tombe à l'endroit où un hider a été attrapé (si le réglage du salon l'autorise).
  function syncTombs() {
    const keep = new Set();
    for (const c of state.catches) {
      const p = state.players.find((x) => x.id === c.id);
      if (!p) continue;
      keep.add(c.id);
      let m = tombs.get(c.id);
      if (!m) {
        const root = h('div', { class: 'tomb', html: TOMB }, h('span', {}, p.name));
        m = L.marker([c.lat, c.lng], {
          icon: L.divIcon({ className: 'pin-wrap', html: root, iconSize: [0, 0] }),
          interactive: false,
          keyboard: false,
        }).addTo(gmap);
        tombs.set(c.id, m);
      }
      m.setLatLng([c.lat, c.lng]);
    }
    for (const [id, m] of tombs) {
      if (!keep.has(id)) {
        m.remove();
        tombs.delete(id);
      }
    }
  }

  function updateAges() {
    const t = now();
    for (const e of pins.values()) {
      e.em.textContent = e.ping.out
        ? 'hors zone, en direct'
        : e.root.classList.contains('stale')
          ? `GPS figé ${ageText(t - e.ping.fixAt)}`
          : ageText(t - e.ping.ts);
    }
  }

  // ───────────── Volet : joueurs et chat ─────────────

  const chatOpen = () => state && !$('game').hidden && !$('sheet').classList.contains('collapsed') && sheetTab === 'chat';

  function renderSheet() {
    const st = state;
    const me = myPlayer();
    const running = st.status === 'running';
    const released = running && now() >= st.releaseAt;
    const hiders = st.players.filter((p) => p.role === 'hider');
    const alive = hiders.filter((p) => !p.caught).length;

    if (chatOpen()) unread = 0;
    $('sheet-summary').replaceChildren(
      st.status === 'ended' ? 'Manche terminée' : `${alive}/${hiders.length} ${plural(hiders.length, 'hider', 'hiders')} en fuite`,
      ...(unread ? [h('i', { class: 'badge' }, String(unread))] : [])
    );
    $('chat-badge').hidden = !unread;
    $('chat-badge').textContent = String(unread);
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === sheetTab);
    $('tab-players').hidden = sheetTab !== 'players';
    $('tab-chat').hidden = sheetTab !== 'chat';
    $('sheet-body').classList.toggle('chat-mode', sheetTab === 'chat');

    $('game-players').replaceChildren(
      ...st.players.map((p) => {
        const actions = [];
        const catchable = released && me.role === 'hunter' && p.role === 'hider' && !p.caught;
        if (catchable) actions.push(h('button', { type: 'button', class: 'btn small danger', onclick: () => catchPlayer(p) }, 'Attrapé'));
        else if (p.role) actions.push(h('span', { class: `tag ${p.role}` }, roleLabel(p.role)));
        if (isHost() && p.id !== st.me && !p.left) actions.push(moreBtn(p));
        let meta = '';
        let alert = false;
        if (p.left) meta = 'a quitté la partie';
        else if (p.caught) meta = p.caughtBy ? `attrapé par ${nameOf(p.caughtBy)}` : 'attrapé';
        else if (p.exposed) {
          meta = 'hors zone, position révélée';
          alert = true;
        } else if (!p.online) meta = 'hors ligne';
        return playerRow(p, { meta, alert, actions });
      })
    );

    $('btn-caught').hidden = !(running && me.role === 'hider' && !me.caught);
    const endBtn = $('btn-end');
    endBtn.hidden = st.status === 'ended' ? false : !(running && isHost());
    endBtn.textContent = st.status === 'ended' ? 'Voir les résultats' : 'Terminer la manche';
    renderChat();
  }

  const QUICK = {
    hider: ['Je bouge', 'Je suis planqué', 'Hunter en vue !', 'Ils sont sur moi', 'RAS'],
    hunter: ["J'en vois un !", 'Je prends le nord', 'Je prends le sud', 'On se regroupe', 'Il est par là'],
    none: ['GG !', 'Revanche ?', 'Bien joué', "J'arrive"],
  };

  function msgEl(m) {
    const st = state;
    const sender = st.players.find((p) => p.id === m.from);
    const team = m.ch !== 'all' && h('span', { class: 'chtag' }, st.status === 'running' ? 'équipe' : m.ch === 'hider' ? 'hiders' : 'hunters');
    return h(
      'li',
      { class: `msg${m.from === st.me ? ' mine' : ''}`, 'data-id': m.id },
      h('div', { class: `who ${sender?.role || ''}` }, m.from === st.me ? 'Moi' : m.name, team, h('time', {}, clock(m.ts))),
      h('p', {}, m.text)
    );
  }

  function renderChat(forceBottom = false) {
    const st = state;
    const me = myPlayer();
    const running = st.status === 'running';
    const list = $('chat-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;

    if (!st.chat.length) {
      list.replaceChildren(
        h(
          'li',
          { class: 'empty' },
          running && me.role
            ? `Les messages d'équipe restent entre ${me.role === 'hider' ? 'hiders' : 'hunters'} jusqu'à la fin de la manche.`
            : 'Aucun message pour le moment.'
        )
      );
    } else {
      const rendered = [...list.querySelectorAll('.msg')].map((li) => Number(li.dataset.id));
      const ids = st.chat.map((m) => m.id);
      const prefix = rendered.length && rendered.every((id, i) => ids[i] === id);
      if (!prefix) list.replaceChildren();
      const have = new Set(prefix ? rendered : []);
      for (const m of st.chat) if (!have.has(m.id)) list.append(msgEl(m));
    }
    if (nearBottom || forceBottom) list.scrollTop = list.scrollHeight;

    const quick = running ? QUICK[me.role] || QUICK.none : QUICK.none;
    const qbox = $('quick');
    if (qbox.dataset.set !== quick.join('|')) {
      qbox.dataset.set = quick.join('|');
      qbox.replaceChildren(...quick.map((t) => h('button', { type: 'button', onclick: () => sendChat(t) }, t)));
    }
    const ch = $('chat-ch');
    ch.hidden = !running || !me.role;
    ch.textContent = chatCh === 'team' ? 'Équipe' : 'Tous';
    ch.className = `ch ${chatCh === 'team' ? `team ${me.role}` : ''}`;
  }

  function sendChat(text) {
    send({ type: 'chat', text, ch: state.status === 'running' ? chatCh : 'all' });
    requestAnimationFrame(() => renderChat(true));
  }

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    sendChat(text);
    $('chat-input').value = '';
  });
  $('chat-ch').addEventListener('click', () => {
    chatCh = chatCh === 'team' ? 'all' : 'team';
    toast(chatCh === 'team' ? 'Messages réservés à ton équipe' : 'Messages visibles par tout le monde');
    renderChat();
  });

  function openSheet(tab) {
    if (tab) sheetTab = tab;
    $('sheet').classList.remove('collapsed');
    if (sheetTab === 'chat') unread = 0;
    if (state) renderSheet();
    if (sheetTab === 'chat') renderChat(true);
  }
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => openSheet(b.dataset.tab));
  $('sheet-handle').addEventListener('click', () => {
    const sheet = $('sheet');
    if (sheet.classList.contains('collapsed')) openSheet(unread ? 'chat' : null);
    else {
      sheet.classList.add('collapsed');
      $('chat-input').blur();
    }
  });

  // ───────────── Fin de manche, podium ─────────────

  function renderResult() {
    const st = state;
    const show = st.status === 'ended' && !hideResult;
    $('result').hidden = !show;
    if (!show) return;

    const res = outcome(st);
    const base = st.releaseAt;
    $('result-icon').innerHTML = res === 'win' ? CROWN_ART : res === 'lose' ? TOMB : MOON_ART;
    $('result-title').textContent = res === 'win' ? 'Victoire' : res === 'lose' ? 'Défaite' : 'Fin de manche';
    $('result-title').className = `result-title ${res}`;
    $('result-sub').textContent = st.allCaught
      ? `Les hunters ont attrapé tout le monde en ${fmt(Math.max(0, st.endedAt - base))}.`
      : st.endReason === 'time'
        ? "Le temps est écoulé : les hiders s'en sortent."
        : "La manche a été arrêtée par l'hôte.";

    const round = st.lastRound || {};
    const rows = st.players.filter((p) => round[p.id]).sort((a, b) => round[b.id].pts - round[a.id].pts);
    $('result-list').replaceChildren(
      ...rows.map((p) => {
        const r = round[p.id];
        const detail =
          p.role === 'hider'
            ? r.survived
              ? `jamais attrapé, ${fmt(r.survivedMs)} en fuite`
              : `attrapé après ${fmt(r.survivedMs)}`
            : `${r.catches} ${plural(r.catches, 'capture', 'captures')}`;
        return h(
          'li',
          {},
          glyph(p),
          h('div', { class: 'pmain' }, nameLine(p), h('div', { class: 'pmeta' }, detail)),
          h('span', { class: `gain${r.pts ? '' : ' zero'}` }, `+${r.pts}`)
        );
      })
    );
    $('result-board').replaceChildren(...boardRows(ranked(st)));

    const host = isHost();
    $('btn-next').hidden = !host;
    $('btn-to-final').hidden = !host;
    const next = { swap: 'Rôles inversés à la prochaine manche.', random: 'Nouveau tirage au sort à la prochaine manche.', manual: "L'hôte refera les équipes." }[
      st.settings.roleMode
    ];
    $('next-hint').textContent = host ? next : `En attente de l'hôte… ${next}`;
  }

  let podiumKey = '';
  function renderFinal() {
    const st = state;
    const list = ranked(st);
    const key = list.map((p) => `${p.id}:${p.score}`).join(',');
    if (key !== podiumKey) {
      podiumKey = key;
      $('podium').replaceChildren(
        ...list.slice(0, 3).map((p, i) =>
          h(
            'div',
            { class: `step p${i + 1}` },
            i === 0 && h('span', { html: ICON.crown }),
            h('div', { class: 'sname' }, p.name),
            h('div', { class: 'spts' }, `${p.score} pts`),
            h('div', { class: 'block' }, String(i + 1))
          )
        )
      );
      $('final-board').replaceChildren(...boardRows(list.slice(3), 3));
    }
    $('btn-reset').hidden = !isHost();
    $('final-hint').textContent = isHost() ? 'Les scores repartent à zéro.' : "En attente de l'hôte pour une nouvelle partie…";
  }

  // ───────────── Annonces plein écran ─────────────

  let splashTimer;
  function splash({ cls, icon, kicker, title, sub }) {
    const el = $('splash');
    el.className = `splash ${cls || ''}`;
    $('splash-icon').innerHTML = icon;
    $('splash-kicker').textContent = kicker;
    // Une lettre par élément : elles tombent l'une après l'autre (voir .splash-title span).
    $('splash-title').replaceChildren(...Array.from(title).map((ch, i) => h('span', { style: `--i:${i}` }, ch === ' ' ? ' ' : ch)));
    $('splash-title').setAttribute('aria-label', title);
    $('splash-sub').textContent = sub;
    el.hidden = true;
    void el.offsetWidth;
    el.hidden = false;
    clearTimeout(splashTimer);
    splashTimer = setTimeout(() => (el.hidden = true), 4100);
  }

  function roleSplash() {
    const st = state;
    const hunter = myPlayer().role === 'hunter';
    const head = Math.round((st.releaseAt - st.startedAt) / 60000);
    splash({
      cls: hunter ? 'hunter' : 'hider',
      icon: hunter ? SCOPE : GHOST('big'),
      kicker: 'Tu es',
      title: hunter ? 'Hunter' : 'Hider',
      sub: head
        ? hunter
          ? `Ne bouge pas. Départ dans ${head} min.`
          : `Cache-toi ! Les hunters partent dans ${head} min.`
        : hunter
          ? 'La chasse est ouverte. Trouve-les.'
          : 'Les hunters sont déjà lâchés. Cours !',
    });
    sfx.play('start');
    buzz([200, 100, 200]);
  }

  function releaseSplash() {
    const hunter = myPlayer().role === 'hunter';
    splash({
      cls: 'hunter',
      icon: SCOPE,
      kicker: hunter ? 'À toi de jouer' : 'Attention',
      title: 'Lâchés !',
      sub: hunter ? 'Le premier ping des hiders arrive sur ta carte.' : 'Les hunters sont lâchés. Ta position vient de partir.',
    });
    sfx.play('release');
    buzz([400, 150, 400]);
  }

  // ───────────── Horloge de l'écran de jeu ─────────────

  // Compte à rebours, âge des pings, alertes de zone : recalculés chaque seconde.
  function tickUI() {
    if (!state || (state.status !== 'running' && state.status !== 'ended')) return;
    const st = state;
    const t = now();
    const me = myPlayer();
    if (!me) return;

    if (st.status === 'running' && lastTick && lastTick < st.releaseAt && t >= st.releaseAt && st.releaseAt > st.startedAt) releaseSplash();
    lastTick = t;

    const chip = $('role-chip');
    chip.textContent = roleLabel(me.role);
    chip.className = `tag ${me.role || ''}`;
    $('round-chip').textContent = `Manche ${st.round}`;

    const hiders = st.players.filter((p) => p.role === 'hider');
    const alive = hiders.filter((p) => !p.caught).length;
    const mine = st.pings.find((p) => p.id === st.me);
    let title = '';
    let time = '';
    let sub = '';
    let urgent = false;

    if (st.status === 'ended') {
      title = 'Manche terminée';
      time = 'Fin';
    } else if (me.role === 'hider' && me.caught) {
      title = "Tu t'es fait attraper";
      time = 'R.I.P.';
      sub = 'Tu suis la fin de la manche en spectateur.';
    } else if (t < st.releaseAt) {
      time = fmt(st.releaseAt - t);
      urgent = st.releaseAt - t <= 10000;
      if (me.role === 'hider') {
        title = 'Cache-toi ! Les hunters partent dans';
        sub = 'Le premier ping partira à leur départ.';
      } else {
        title = 'Ne bouge pas ! Départ dans';
        sub = 'Les hiders sont en train de se cacher…';
      }
    } else {
      time = fmt(st.nextPingAt - t);
      urgent = st.nextPingAt - t <= 10000;
      const left = st.endsAt ? `, fin dans ${fmt(st.endsAt - t)}` : '';
      if (me.role === 'hider') {
        title = 'Prochain ping de ta position dans';
        sub = (mine ? `Dernier ping ${ageText(t - mine.ts)}` : 'Aucun ping envoyé pour le moment') + left;
      } else {
        title = 'Prochain ping des hiders dans';
        sub = `${alive} ${plural(alive, 'hider', 'hiders')} en fuite${left}`;
      }
    }
    $('phase-title').textContent = title;
    const timeEl = $('phase-time');
    timeEl.textContent = time;
    timeEl.classList.toggle('urgent', urgent);
    timeEl.classList.toggle('small', !/\d/.test(time));
    $('phase-sub').textContent = sub;

    updateAges();
    updateWarn(t);
  }
  setInterval(tickUI, 1000);

  function updateWarn(t = now()) {
    const el = $('warn');
    let w = null;
    if (state?.status === 'running') {
      const me = myPlayer();
      const grace = state.settings.outGraceSec;
      const hiding = me.role === 'hider' && !me.caught;
      if (geo.status === 'denied' || geo.status === 'unsupported') {
        w = { cls: 'info', title: 'Localisation coupée', msg: 'Autorise-la dans les réglages du navigateur pour jouer.', count: '!', frac: 1 };
      } else if (hiding && me.exposed) {
        w = { cls: 'exposed', title: 'Position révélée', msg: 'Les hunters te suivent en direct. Rentre dans la zone !', count: '!', frac: 1 };
      } else if (hiding && (me.outSince || geo.out)) {
        if (grace > 0) {
          const left = Math.max(0, grace * 1000 - (t - (me.outSince ?? t)));
          const s = Math.ceil(left / 1000);
          w = { title: 'Hors zone', msg: `Rentre vite : ta position sera révélée dans ${s} s.`, count: String(s), frac: left / (grace * 1000) };
          if (s !== lastWarnSec) sfx.play('tick');
          lastWarnSec = s;
        } else w = { title: 'Hors zone', msg: 'Rentre dans la zone de jeu.', count: '!', frac: 1 };
      } else if (me.role === 'hunter' && geo.out) {
        w = { title: 'Hors zone', msg: 'Reviens dans la zone de jeu.', count: '!', frac: 1 };
      } else if (!geo.pos) {
        w = { cls: 'info', title: 'GPS', msg: 'Recherche de ta position…', count: '…', frac: 1 };
      }
    }
    el.hidden = !w;
    $('game').classList.toggle('danger', Boolean(w) && w.cls !== 'info');
    if (!w) {
      lastWarnSec = null;
      return;
    }
    const cls = `warn ${w.cls || ''}`.trim();
    if (el.className !== cls) el.className = cls;
    $('warn-title').textContent = w.title;
    $('warn-msg').textContent = w.msg;
    $('warn-count').textContent = w.count;
    $('warn-arc').style.strokeDashoffset = String(119.4 * (1 - w.frac));
  }

  // ───────────── Boutons de la partie ─────────────

  $('btn-caught').addEventListener('click', async () => {
    const hunters = state.players.filter((p) => p.role === 'hunter' && !p.left);
    const v = await ask({
      title: 'Attrapé ?',
      text: "Qui t'a eu ? Il marque les points de la capture.",
      actions: [
        ...hunters.map((p) => ({ label: p.name, value: p.id })),
        { label: 'Je ne sais pas', value: '?' },
        { label: 'Annuler', value: null, cls: 'ghost' },
      ],
    });
    if (v) send({ type: 'caught', by: v === '?' ? null : v });
  });

  $('btn-end').addEventListener('click', async () => {
    if (state.status === 'ended') {
      hideResult = false;
      return renderResult();
    }
    if (await confirmAsk('Terminer la manche ?', 'Elle s’arrête pour tout le monde et les points sont comptés.', 'Terminer', 'danger')) {
      send({ type: 'end' });
    }
  });

  $('btn-next').addEventListener('click', () => send({ type: 'next' }));
  $('btn-to-final').addEventListener('click', askFinal);
  $('btn-map').addEventListener('click', () => {
    hideResult = true;
    renderResult();
  });
  $('btn-leave-game').addEventListener('click', async () => {
    const me = myPlayer();
    const text = state.status === 'running' && me?.role === 'hider' && !me.caught ? 'Un hider qui part compte comme attrapé.' : '';
    if (await confirmAsk('Quitter la partie ?', text, 'Quitter', 'danger')) leave();
  });
  $('btn-reset').addEventListener('click', () => send({ type: 'reset' }));
  $('btn-final-quit').addEventListener('click', leave);

  $('btn-me').addEventListener('click', () => {
    if (!geo.pos) return toast("Position indisponible pour l'instant.");
    gmap.setView([geo.pos.lat, geo.pos.lng], Math.max(gmap.getZoom(), 16));
  });
  $('btn-zone').addEventListener('click', () => fitZone(true));

  // ───────────── Démarrage ─────────────

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      hiddenAt = Date.now();
      return;
    }
    const me = myPlayer();
    if (state?.status === 'running' && me?.role === 'hider' && !me.caught && hiddenAt && Date.now() - hiddenAt > 20000) {
      toast("Appli en arrière-plan : ta position n'était plus envoyée.", 'alert');
    }
    hiddenAt = 0;
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
