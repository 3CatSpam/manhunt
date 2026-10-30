# Manhunt

French-language PWA for the Instagram "manhunt" game: hunters vs hiders on a real map, with location pings every few minutes.
Halloween look: night map, ghosts for hiders, tombstones where they got caught.
The list of what was added on 30 Oct 2026 (in French) is in [docs/ajouts-mathieu.md](docs/ajouts-mathieu.md).

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # game-rule unit tests
npm run icons      # regenerate the PWA icons
```

Geolocation only works over **HTTPS** (localhost excepted). To play on phones, either deploy to any
Node host that supports WebSockets (Render, Fly.io, Railway, a VPS behind Caddy/nginx), or tunnel
your machine while testing, e.g. `npx cloudflared tunnel --url http://localhost:3000`.

Rooms are saved to `data/rooms.json` every 5 s (override with `DATA_FILE`), so a crash or restart
does not end running games: phones reconnect and pick up where they left off. On hosts with an
ephemeral disk (Render's free plan, for example) point `DATA_FILE` at a persistent volume.

## How it works

- `game.js` — all game rules (roles, head start, pings, zone exits, chat, scores, who may see what). No I/O, unit-tested.
- `server.js` — Express (static files) + WebSocket (`/ws`), plus the save file.
- `public/` — vanilla JS PWA, Leaflet + OpenStreetMap tiles (darkened with a CSS filter), city search via Nominatim,
  sounds synthesised with the Web Audio API.

Privacy by design: phones stream their GPS to the server, but the server only shares a hider's position
**at each ping tick**, or live once they have stayed outside the zone too long. The live position is never
sent otherwise, and the "hiders can't see other hiders' pings" option and team chat are enforced server-side.

## Rules implemented

- Lobby with a 4-letter code; the host picks the city (search or "my position"), the zone radius and the options.
- Roles: swapped every round (with a fixed hunter count, everybody takes a turn as hunter), drawn at random
  every round, or placed by hand by the host. The number of hunters is "half" or 1, 2, 3.
- Hunters wait during the head start (default 10 min). Pings then start, every 5 min by default.
- Hunters see every hider's last ping; hiders see their allies' last pings unless the host turned that option off.
- Leaving the zone: the player gets a countdown; after 30 s outside (or 1 min, or never, per settings) a hider's
  position is shown live to the hunters until they come back.
- The hunt has a configurable duration (default 1 h, counted from the end of the head start, or unlimited). When time runs out the hiders win.
- A hider is out when they tap "Je me suis fait attraper" (and say which hunter got them) or a hunter marks them.
  The round ends when all hiders are caught (or the host ends it).
- Scores add up across rounds: 10 pts per minute on the run (+50 if still free when time runs out),
  100 pts per catch (+50 each if the hunters catch everyone). The host can end the evening on a podium, then reset.
- Team chat with quick messages; team messages are revealed to everyone when the round ends.
- The host can hand over the host role or kick a player.

## Limits worth knowing

- Browsers suspend GPS when the screen locks or the app goes to the background. The app keeps the screen on
  (wake lock), flags frozen positions on the map ("GPS figé") and warns a hider who came back from the background,
  but players should keep it open and in the foreground (a native app would be needed for true background tracking).
- OpenStreetMap's public tile server and Nominatim are for light use; switch the tile URL in `public/app.js` to a
  commercial provider if you scale up.
