# Brim

A party relay for phones. Your phone is a glass filled to the brim, and the drink
sloshes as you move. Two teams (Sunrise and Lagoon) run legs around a course you
build out of furniture. At the end of each leg you hold the button and tip your phone
over the next runner's phone: the drink pours across through the server, into a
glass sized so it starts brim-full again. Everyone who isn't holding a glass throws
mischief cards at the other team's runner (quake, ice cube, fizz, frost, swell) or
puts a lid on their own. Most drink delivered wins. Works solo too (a calm or a
chaos carry with a personal best), and a TV or laptop can be the big screen.

Live at <https://play.jadon.me/brim/> (big screen: `?tv`).

## How it works

- `public/js/liquid.js`: the drink, a 2D shallow-water height field on a disc with
  a weir-law overflow at the rim, floating ice cubes and a foam head.
- `public/js/glass.js`: draws the glass in a 3/4 view on a bar counter (Canvas 2D),
  plus the flat tipped view used while pouring.
- `public/js/sensors.js`: devicemotion/deviceorientation, the iOS permission flow,
  a sign check between platforms, the glass's own frame (the drink feels the phone's
  specific force), a step counter and the `?dev` keyboard simulation.
- `public/js/carry.js`: the runner's glass (sensors → sim → render), pouring and
  catching. `stage.js` draws copies of other runners' glasses from telemetry.
- `public/js/rules.js`: everything both sides agree on (fills, cards, timings).
- `server.js`: static files + WebSocket rooms. The server keeps the relay's clock and
  running order, relays pours between phones, and referees the cards (team charges,
  cooldowns, a shield after each hit). The runner's phone owns how much drink is
  left; the server only lets it go down.

## Run

```
npm install
npm start            # http://localhost:3120
npm test             # headless bot matches against the server
node test/bots.js CODE 3     # fill a real room with bot phones
node tools/tune.mjs          # how much each walking style / card spills
```

Motion sensors need HTTPS on a real phone. On a desktop, `?dev` simulates them:
arrows tilt, W/A/S/D shove, G walk, Space footstep, Q shake, T/Y tip to pour,
Enter holds the button. `?lab` shows a bare glass for tuning the look.

## Deploy

Container `brim` on port 3120 behind Caddy at `/brim/`, like the other
play.jadon.me games (see `../play/DEPLOY.md`).
