# Starside Movers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shareable 3D multiplayer moving-truck loading party game for 1–4 players, with an email gate.

**Architecture:** An authoritative Colyseus room simulates at 20 Hz and broadcasts JSON snapshots. Pure rules
(grid drop, crush checks, voting, scoring) live in `shared/logic.js` and are unit-tested with `node --test`.
A Vite + Three.js client renders a top-down scene, interpolates snapshots, and sends inputs.

**Tech Stack:** Node 22, colyseus 0.16.x, @colyseus/ws-transport 0.16.x, express, colyseus.js 0.16.x, three 0.187, vite 8.

**Spec:** `docs/superpowers/specs/2026-11-21-starside-movers-design.md`

## Global Constraints
- Grid 4 wide (x) × 4 deep (z) × 4 tall (y).
- Points: standard 10, heavy 20, fragile 15, lamp 25, couch 60, desk 50, table 40. Helpers +5. Penalty −15. 2 strikes = out.
- Round times: 180 s, 300 s, "until loaded" (safety cap 900 s). Meeting 25 s.
- One server process serves the client build plus WebSocket on `PORT` (default 2567).
- Must be playable with touch only (joystick + ACTION + DASH + ROTATE + CALL OUT).

## Review Focus
- Joining with no or invalid gate token → room join rejected with a clear message. The client re-shows the gate.
- A player disconnects mid-carry → their item drops on the floor where they stood, and a 2-person carry releases.
- An item can't fit (column too tall) → drop refused with a toast, and the item stays carried.
- A meeting is called while another is running, or by an eliminated player → ignored.
- A room is joined after its round has started → the player joins as a spectator until the next round.

---

### Task 1: Shared rules (`shared/logic.js`)
**Files:** Create `shared/logic.js`, `test/logic.test.js`
**Produces:**
- `ITEM_TYPES` map with `{w, d, pts, heavy, fragile, needsWrap, needsDisassemble, teamCarry}` per type.
- `createGrid() -> Grid` (`cells[x][z][y] = itemId|null`, `items: Map`)
- `dropHeight(grid, x, z, w, d) -> number` (the resting y, or -1 if it would exceed 4 or go out of bounds)
- `placeItem(grid, item, x, z, rot) -> {ok, y, broken: itemIds[]}`. Breaks a fragile box under a heavy or furniture item, and an unwrapped lamp.
- `tallyVotes(votes: {voterId: targetId|'skip'}, callerId) -> targetId|'skip'`
- [ ] Tests: drop onto an empty grid gives y=0. Stacking gives y=1. A full column gives -1. A 2×1 piece rests on the max of its footprint. A heavy box on fragile breaks the fragile one. Standard on fragile doesn't break it. A tie goes to the caller's vote.
- [ ] Implement, run `node --test`, commit.

### Task 2: Server room + gate
**Files:** `server/index.js`, `server/MoveRoom.js`, `server/world.js` (house walls, item spawns), `server/signups.js`
- `POST /api/signup {name,email}` → validates the email, appends to `data/signups.jsonl`, returns `{token}` (an HMAC of the email).
- The room's `onAuth` checks the token. Messages: `input {mx,mz,act,dash,rot}`, `start {mode}`, `char {id}`, `callout`, `vote {target}`, `chat {text}`.
- The sim covers movement and wall collision, pickup/carry, hold-tasks, the truck zone and placement, meetings, scoring, and round end.
- [ ] Smoke test: script connects 2 clients with colyseus.js, starts a round, receives `snap`.

### Task 3: Client
**Files:** `client/index.html`, `client/src/main.js`, `client/src/scene.js`, `client/src/models.js`, `client/src/input.js`, `client/src/ui.js`, `client/src/style.css`
- Screens: gate → lobby (character pick, round mode, share link) → game HUD → meeting overlay → results.
- [ ] Headless Playwright check: two pages join the same room, a screenshot of the HUD, no console errors.

### Task 4: Concept art + deploy
- Concept art page (SVG characters, house map, truck grid) published as an artifact and saved in `docs/concept-art.html`.
- Dockerfile, render.yaml, README with deploy steps. Live public URL via tunnel from this session.
