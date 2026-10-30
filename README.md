# Manhunt

French-language PWA for the Instagram "manhunt" game: hunters vs hiders on a real map, with location pings every few minutes.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # game-rule unit tests
```

Geolocation only works over **HTTPS** (localhost excepted). To play on phones, either deploy to any
Node host that supports WebSockets (Render, Fly.io, Railway, a VPS behind Caddy/nginx), or tunnel
your machine while testing, e.g. `npx cloudflared tunnel --url http://localhost:3000`.

## How it works

- `game.js` — all game rules (roles, head start, ping schedule, who may see which ping). No I/O, unit-tested.
- `server.js` — Express (static files) + WebSocket (`/ws`). Rooms live in memory: a server restart ends running games.
- `public/` — vanilla JS PWA, Leaflet + OpenStreetMap tiles, city search via Nominatim.

Privacy by design: phones stream their GPS to the server, but the server only shares a hider's position
**at each ping tick**. The live position is never sent to other players, and the "hiders can't see other
hiders' pings" option is enforced server-side, not just hidden in the UI.

## Rules implemented

- Lobby with a 4-letter code; the host picks the city (search or "my position"), the zone radius and the options.
- First round: random split, half hiders / half hunters. Each next round: roles are swapped.
- Hunters wait during the head start (default 10 min). Pings then start, every 5 min by default.
- Hunters see every hider's last ping; hiders see their allies' last pings unless the host turned that option off.
- The hunt has a configurable duration (default 1 h, counted from the end of the head start, or unlimited). When time runs out the hiders win.
- A hider is out when they tap "Je me suis fait attraper" or a hunter marks them. The round ends when all hiders are caught (or the host ends it).

## Limits worth knowing

- Browsers suspend GPS when the screen locks or the app goes to the background. The app requests a screen
  wake lock, but players should keep it open and in the foreground (a native app would be needed for true background tracking).
- OpenStreetMap's public tile server and Nominatim are for light use; switch the tile URL in `public/app.js` to a
  commercial provider if you scale up.
