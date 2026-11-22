# ★ Starside Movers

A 3D multiplayer moving-day party game in the browser. Up to 4 movers (astronauts and aliens) load a
Starside Movers truck Tetris-style. Heavy boxes crush fragile ones. When something breaks, call out the
crewmate who did it in a crew meeting. Two strikes and you're off the truck.

- **Three.js** top-down 3D. Works on phone (touch joystick + buttons) and desktop (keyboard). Nothing to download.
- **Colyseus** real-time multiplayer. Share the invite link and friends join the same crew.
- **Email gate** before the first match. Signups land in `data/signups.jsonl`.
- **Solo vs 3 AI movers** (Easy / Normal / Hard), or friends + AI in any mix.
- A **new procedurally generated house** every round.
- Games: **🏆 Competitive** (most points still on the truck wins) or **🕵️ Sabotage** (one secret saboteur).
- Rounds: **3 min**, **5 min**, or **🧩 Full load** (the house holds exactly one truckload; pack it perfectly).

## Controls
| | Desktop | Phone |
|---|---|---|
| Move / aim in truck | WASD / arrows | left-side joystick |
| Grab, drop, load | tap **E** / Space | ✋ ACTION (tap) |
| Pad-wrap / disassemble | hold **E** | hold ✋ ACTION |
| Dash (ability) / back out of truck | Shift | 🚀 DASH / BACK |
| Rotate / flip furniture in truck | R | ⟳ ROTATE |
| Aim in the truck | move, or point at the grid | D-pad, or drag on the truck |
| Unload a piece (Full load) | hold **E** on the ramp | hold ✋ on the ramp |
| Call for help with a 2-mover lift | H | 🆘 HELP |
| Call out a crewmate | Q or the CALL OUT pill | 📣 CALL OUT |
| Chat (lobby + meetings) | Enter | tap the chat box |

## Run locally
```bash
npm install
npm run build        # builds the client into dist/
npm start            # http://localhost:2567
npm test             # rules + room unit tests
```
For development, run `npm run dev:server` and `npm run dev:client` (Vite on :5173) at the same time.

## Deploy to a public URL
It's a single Node service that serves both the game and the WebSocket, so any Node or Docker host works.

**Render (easiest):** push this folder to a GitHub repo, then go to Render → **New → Blueprint** → pick the repo.
`render.yaml` sets up the build, a health check, a persistent disk for signups, and secrets.
You'll get a `https://starside-movers-game.onrender.com`-style URL to post.

**Fly.io / Railway / any Docker host:** `docker build -t starside-movers . && docker run -p 2567:2567 -v $PWD/data:/data starside-movers`.

### Environment variables
| Var | Purpose |
|---|---|
| `PORT` | listen port (default 2567) |
| `DATA_DIR` | where `signups.jsonl` and the gate secret live (default `./data`) |
| `GATE_SECRET` | HMAC secret for gate tokens (auto-generated and saved if unset) |
| `ADMIN_KEY` | enables `GET /api/signups.csv?key=…` to download your email list |
| `DEBUG_HOOKS` | `1` enables test-only hooks. **Leave unset in production.** |

## Project layout
```
shared/logic.js   pure rules: grid drop, crush, votes, points (unit-tested)
shared/world.js   house + truck layout used by server and client
server/           Express + Colyseus room (authoritative 20 Hz sim), email gate
client/           Vite + Three.js: scene, models, touch/keyboard input, UI
docs/             design spec, implementation plan, concept art
test/             node --test unit tests + Playwright e2e scripts
PROGRESS.md       build log
```
