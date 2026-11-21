# Starside Movers — Game Design

## Intent
A fun 1–4 player browser party game, branded **Starside Movers**, that teaches real moving-crew
know-how (heavy on the bottom, fragile on top, pad-wrap furniture, disassemble big pieces,
team-lift heavy items) through play. The link gets shared, friends join instantly, and there's
an email gate that captures leads before the first match.

## Goals
- Three.js 3D (top-down camera, like a social-deduction game's map view), playable on phone + desktop, no download.
- Real-time multiplayer via Colyseus WebSockets; share a link → same match.
- Rounds: 3 min, 5 min, or "until loaded" (host picks).
- Simple controls: move, aim, action, one ability (jetpack dash) + a call-out button.
- Email gate (name + email) saved server-side before first match.
- Publicly deployable (single Node service; Dockerfile + render.yaml).

## Non-goals
- Accounts/passwords, persistent progression, matchmaking beyond share links.
- Realistic physics. Cargo uses a discrete Tetris-style grid.

## Anti-goals
- Controls too fiddly for a phone. Every interaction must work with joystick + 1 button.
- Rounds that drag. Default 3 minutes.

## Rules
### Movers
4 playable characters (2 astronauts, 2 aliens): **Nova** (orange-suit astronaut), **Cosmo**
(teal-suit astronaut), **Glorp** (green one-eyed alien), **Zibble** (purple antenna alien).
All movers start in the truck's cargo bay.

### Items
| Item | Cells | Points | Notes |
|---|---|---|---|
| Standard box | 1 | 10 | — |
| Heavy box | 1 | 20 | Carrier moves at 60% speed. Crushes a fragile box it lands on. |
| Fragile box | 1 | 15 | Breaks if a heavy box or furniture lands on it. |
| Lamp | 1 | 25 | Needs pad-wrapping, otherwise breaks on load. Solo carry. |
| Couch | 2×1 | 60 | Needs wrapping (otherwise "scuffed", half pts). **2-person carry.** |
| Desk | 2×1 | 50 | Must be disassembled before moving. 2-person carry. |
| Table | 2×1 | 40 | Must be disassembled. 2-person carry. |

Wrapping takes 2.5 s of held action. Disassembling takes 3 s. Extra helpers speed it up, and each
helper earns +5. Carry points are split between the carriers.

### Truck (cargo grid)
4 wide × 4 deep × 4 tall = 64 cells. When you step onto the ramp/bay while carrying, a ghost
appears over the grid. Move to aim the column. **R** (or the rotate button) rotates 2-cell items.
Action drops the item, which falls to the lowest resting height across its footprint. An item that
would rise above height 4 can't be placed there.

### Damage, call-outs, strikes
- Breaks are announced anonymously ("CRUNCH! Something broke in the truck"). The broken item is
  removed from the grid and its points come off whoever loaded it. The server privately records
  the culprit as whoever dropped the crushing item.
- Anyone can press **CALL OUT** while at least one break is unresolved. A meeting opens for 25 s
  with chat and a vote. Every active mover votes for one player or skips. Plurality wins, and
  ties go to the caller's vote.
  - Accused is the culprit of an unresolved break → that culprit gets **−15 and a strike**, and the break is resolved.
  - Wrong accusation (or the vote skips) → the **caller** gets −15 and a strike.
- 2 strikes → **off the truck** (eliminated). They become a spectator and can't win.
- Unresolved breaks at round end are revealed in the summary ("the truth comes out").

### End and winner
The round ends when time runs out, when every item is loaded or broken (in "until loaded" mode
this is the only end besides a 15-min safety cap), or when every mover is eliminated. **Winner =
highest score among movers still on the truck.** The team truck total is shown as well.

### Cute stuff
A wandering space moon-cat (cosmetic) roams the house. Emote pops show when you lift, wrap or
break something. Mover tips appear on the loading screen and as in-game toasts.

## Architecture
- `server/` — Node + Colyseus 0.16 + Express. `MoveRoom` runs an authoritative sim at 20 Hz and
  broadcasts JSON snapshots (`snap`) at 15 Hz. Pure game rules live in `shared/logic.js` (unit-tested).
- `client/` — Vite + Three.js. Interpolates snapshots. Virtual joystick + buttons on touch.
- Email gate: `POST /api/signup` → `data/signups.jsonl`, returns a token stored in localStorage.
  The client must have a token to join a room, and the server verifies it on `onAuth`.
- Share link: `/?room=<roomId>`.

## Approaches considered
1. **Colyseus with JSON snapshots over messages (chosen).** Version-robust and simple. The bandwidth is fine for 4 players.
2. Colyseus Schema state sync. More efficient but the API churns between versions, and the extra
   schema boilerplate isn't worth it for 4 players.
3. Peer-to-peer WebRTC. No server cost, but the prompt asked for Colyseus and there would be no authoritative anti-cheat.

## Builder's calls (made by Claude, open to change)
Grid size 4×4×4, point values, timings, the −15 penalty, the 25 s meeting, a 1-player test mode
(you can play solo, and 2-person carries become possible solo at 40% speed when you're alone),
and the jetpack dash (2× speed for 0.6 s, 5 s cooldown).
