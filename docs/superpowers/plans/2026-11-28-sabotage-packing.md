# Sabotage: Pack the House Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace today's Sabotage with the "pack the house" game: rooms packed from flat boxes, permanent breakage, eight
sabotage actions with tells and fixes, witnesses/inspection/roles, untimed endings, fair AI.

**Architecture:** All Sabotage rules live in a new `SabotageGame` (server/sabotage/) that `MoveRoom` creates when
`game === 'sabotage'` and calls through a handful of hook points (setup, tick, tap, hold, sabotage, meetings, end check,
snapshot). Pure rules and numbers live in `shared/sabotage.js` so tests, AI and client read the same values. Competitive,
Full load and Teams never enter the new code.

**Tech Stack:** Node 22, Colyseus 0.18 (server), three.js + Vite (client), node:test, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-28-sabotage-packing-design.md`

## Global Constraints

- Other modes untouched: every new behaviour sits behind `room.sab` (only set when `game === 'sabotage'`).
- Server authoritative; the client only renders what the snapshot says.
- No timer in Sabotage; old overtime/drain code is not used when `room.sab` exists.
- AI reads only what it can see (`Bot.canSeePoint`, 9 m, walls, lights) — never roles, tampered flags, or box types before packing.
- Crew size 4–6 (default 6); 2 saboteurs at 6, 1 at 4–5; AI fills seats.
- Numbers come from `SAB` in `shared/sabotage.js` (values below are the spec's starting values).
- Debug hooks only via `debugHooksOn()`.
- Commit trailer as for every commit in this repo.

## Review Focus

1. **A mover leaves or drops mid-hold / mid-carry** (flat box, pile repack, sabotage hold, two-person repair): the hold is
   cancelled, a carried flat box returns to the stack, nothing is left half-done. → Task 3 and Task 6 tests.
2. **The house can never empty** (a pile spawned inside a wall, upstairs behind a broken stair, an item outside the map):
   piles spawn on a walkable spot; drive-off must trigger when only lost things remain. → Task 4 and Task 8 tests.
3. **Players leave mid-round**: the outnumber check and role holders (Driver/Inspector/Foreman) update immediately. → Task 5 and Task 8 tests.
4. **Meeting during an action**: holds freeze and resume; no sabotage finishes during a meeting; lights-out timers pause. → Task 7 tests.
5. **Mislabelled fragile box**: shows standard everywhere (marks, aiming outline, AI) but still crushes. → Task 6 test.

---

### Task 1: Shared rules and numbers

**Files:**
- Create: `shared/sabotage.js`
- Test: `test/sabotage-rules.test.js`

**Interfaces:**
- Produces:
  - `SAB` constants: `PACK_SOLO 7, PACK_PAIR 3, REPACK_SOLO 5, REPACK_PAIR 2.5, PAIR_RADIUS 1.5, PILE_FULL_S 10, PILE_HALF_S 40, SAB_COOLDOWN 20, WEAK_BATCH 3, WEAK_BURST_ON_LIFT 0.35, WEAK_BURST_PER_S 0.02, LIGHTS_OUT_S 40, PADS_OUT_S 30, INSPECT_COOLDOWN 20, MEETING_COOLDOWN 30, LOSS_LINE 0.35, SAFETY_LINE 70, GHOST_SPEED 0.5, DAMAGED_VALUE 0.5, SIGHT_M 9, DARK_SIGHT_M 2`, and `HOLD = { weaken 2, cutTape 1.5, mislabel 2, loosen 2, snag 2, stashPads 2, lightsOut 1.5, pullTruck 2.5, retape 2, fixWheel 3, refillPads 2, breaker 2, inspect 2, restrap 3 }`.
  - `BOX_MIX: Record<role, [std, heavy, fragile]>` with the spec table (kids and play share a row; hall/passage/stairs absent).
  - `roomQuotas(rooms, boxCells) -> Map<roomIndex, n>` (area-weighted, ≥1 per eligible room, sums to `boxCells`).
  - `mixBag(role, n, rng) -> ('standard'|'heavy'|'fragile')[]` (shuffled, proportions as close as integers allow).
  - `pileValueFactor(ageSec) -> number` (1 until 10 s, linear to 0.5 at 40 s, 0.5 after).
  - `sabotageOutcome({ houseValue, lostValue, saboteursAlive, crewAlive, houseEmpty, safety, saboteursOut }) -> null | { winner: 'crew'|'saboteur', reason }`.

- [ ] **Step 1: Write the failing tests** — `roomQuotas` sums to `boxCells`, gives halls 0 and every other room ≥1;
  `mixBag('bathroom', 5)` all fragile; `mixBag('kitchen', 20)` has 12 fragile, 5 standard, 3 heavy; `pileValueFactor(0)=1`,
  `(10)=1`, `(25)=0.75`, `(40)=0.5`, `(90)=0.5`; `sabotageOutcome` returns saboteur at lost = 0.35·value, saboteur when
  saboteursAlive ≥ crewAlive, crew when saboteursOut, crew when houseEmpty and safety 70, saboteur when houseEmpty and safety 69, else null.
- [ ] **Step 2: Run** `node --test test/sabotage-rules.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the module (largest-remainder rounding for quotas and bags; seeded `rng` from `shared/level.js`'s generator).
- [ ] **Step 4: Run** the test — PASS.
- [ ] **Step 5: Commit** `feat(sabotage): shared rules, numbers and endings`.

### Task 2: The Sabotage game seam and house conversion

**Files:**
- Create: `server/sabotage/game.js`
- Modify: `server/MoveRoom.js` (`startRound`, `resetWorld`, `tick`, `onTap`, `updateTasks`, `checkEnd`, `snapshot`, `respawn`, `recordBreak`, `canCallOut`, `callMeeting`, `updateMeeting`, `resolveSabotageVote`)
- Test: `test/sabotage-setup.test.js`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `class SabotageGame { constructor(room); setupWorld(); tick(dt); onTap(p) -> boolean; onHold(p, dt) -> boolean; onSabotage(p) -> void; onMeetingStart(); onMeetingEnd(); onBreak(item, how) -> boolean /* true = handled, no respawn */; checkEnd() -> null|{winner, reason}; snapshot() -> object; onLeave(p) }`.
  Room fields: `room.sab` (instance or null). New item types in `ITEM_TYPES` (non-cargo, `pts: 0`): `flatstack`, `flatbox`, `pile`, `padcrate`, `breaker`. Item fields used later: `room` (index), `tampered: null|'weak'|'cut'|'mislabel'|'loose'|'snag'`, `damaged`, `shownType`, `lastHandlers: string[2]`.
- In `MoveRoom`: when `this.sab`, each hook calls the matching `sab` method first and returns if it handled it; the old sabotage overtime/drain branch in `checkEnd` is skipped.

- [ ] **Step 1: Failing tests** — a 6-mover sabotage room after `startRound()` has: no `standard|heavy|fragile` items on the floor; every generated furniture piece still present; `sab.quota` sums to 64 minus furniture cells; one `flatstack` item within 2 m of the ramp; one `padcrate` by the ramp; one `breaker` in the garage or laundry (else the first room); a competitive room's items are unchanged (same seed, same item list as before this task).
- [ ] **Step 2: Run** `node --test test/sabotage-setup.test.js` — FAIL.
- [ ] **Step 3: Implement** `setupWorld()` (quota from `roomQuotas`, per-room `mixBag` from the level seed) and the hook calls.
- [ ] **Step 4: Run** this test and `npm test` — all PASS.
- [ ] **Step 5: Commit** `feat(sabotage): game seam and packed-house setup`.

### Task 3: Flat boxes, packing and the work log

**Files:**
- Modify: `server/sabotage/game.js`
- Test: `test/sabotage-packing.test.js`

**Interfaces:**
- Produces: `sab.packing: Map<playerId, { roomIndex, t, partnerId|null, kind: 'pack'|'repack', pileId? }>`; `sab.log: { at, text }[]` (last 30); `sab.roomDone(roomIndex) -> {packed, quota}`.

- [ ] **Step 1: Failing tests** — tap the stack: carrying a `flatbox`; hold ACTION in a room with quota alone for 6.9 s: not packed; at 7.0 s: one packed box of the room's next bag type at the mover's feet, meter +1, flat box gone; with a second empty-handed mover holding within 1.5 m, packing completes at 3.0 s and both get a log entry "A + B packed in the Kitchen"; holding in a hall or a full room does nothing and tells the mover why; a mover who disconnects while carrying a flat box: the box is removed (stack is unlimited) and their packing entry cleared.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in `onTap` / `onHold` / `onLeave`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(sabotage): flat boxes, pair packing, work log`.

### Task 4: Permanent breakage, piles and furniture damage

**Files:**
- Modify: `server/sabotage/game.js`, `server/MoveRoom.js` (`spillFromFlat`, dolly spill path in `updateDollies`)
- Test: `test/sabotage-breakage.test.js`

**Interfaces:**
- Produces: `sab.lostValue` (number), `sab.houseValue`; `sab.burst(box, by)`; piles as items `{ type:'pile', contents:'standard'|'heavy', value, bornAt }`.

- [ ] **Step 1: Failing tests** — a crushed fragile box is removed and its value added to `lostValue` (no respawn); a burst standard box leaves a `pile` on a walkable tile (spawned inside a wall → moved to the nearest walkable tile); repacking it within 10 s (hold with a flat box, 5 s alone / 2.5 s pair) gives a box marked `fragile` worth the full standard value; repacked at 25 s it is worth 0.75 and `lostValue` grows by 0.25·value; furniture that falls off either dolly becomes `damaged`, worth 0.5, adds 0.5·value to `lostValue`, and counts as a damaged piece in the drive-off safety %.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (`onBreak` returns true so `MoveRoom.respawn` is skipped).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(sabotage): permanent breakage, piles, damaged furniture`.

### Task 5: Roles, cover tasks and job lists

**Files:**
- Create: `server/sabotage/roles.js`
- Modify: `server/sabotage/game.js`, `server/MoveRoom.js` (`sendRole`)
- Test: `test/sabotage-roles.test.js`

**Interfaces:**
- Produces: `dealRoles(movers, rng) -> Map<id, 'saboteur'|'foreman'|'inspector'|'driver'|'mover'>`; `jobsFor(sab, p) -> { text, roomIndex|null }[3]` (saboteurs get the same shape, drawn from real house state, so they're indistinguishable); private event `{ kind:'role', role, partners? }`; public `roles` in snapshot without saboteurs.

- [ ] **Step 1: Failing tests** — 6 movers: exactly 2 saboteurs who are told each other's id; foreman, inspector, driver each exactly once among crew; 4 movers: 1 saboteur, no driver; foreman has 2 emergency meetings, others 1; the snapshot never contains a saboteur flag for anyone; when the driver leaves or is voted out, another living crew mover becomes driver within one tick.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(sabotage): roles, partners, cover tasks, job lists`.

### Task 6: Sabotage actions and repairs

**Files:**
- Create: `server/sabotage/actions.js`
- Modify: `server/sabotage/game.js`, `server/MoveRoom.js` (`onMessage('sab')`, input field `sabN`, aiming check in `dropIntoTruck` uses `shownType`)
- Test: `test/sabotage-actions.test.js`

**Interfaces:**
- Produces: `ACTIONS: Record<name, { target(sab, p) -> item|room|null, hold: number, apply(sab, p, target) }>` for `weaken, cutTape, mislabel, loosen, snag, stashPads, lightsOut, pullTruck`; `REPAIRS` for `retape, fixWheel (two movers), refillPads, breaker, relabel (inspector), restrap (driver)`; `sab.cooldown: Map<id, seconds>`; `sab.dark: Map<roomIndex, secondsLeft>`; `sab.padsOutT`.
- Message `sab` (no payload): starts the hold for the best target in reach; client sends it from the new button/key.
- Snapshot: each item carries `shownType` (what the marks show) and a `tell` string (`'sag'|'tape'|'wheel'|'frayed'|null`) — never the real `tampered` value. The client draws marks and the aiming outline from `shownType`.

- [ ] **Step 1: Failing tests** — one per action: after its hold completes the target gets its effect (values from `SAB`/`HOLD`); a second sabotage within 20 s is refused; nothing completes while `room.phase === 'meeting'`; `pullTruck` refused if a crew mover is within 3 m of the ramp; mislabelled fragile has `shownType 'standard'` in the snapshot and still breaks under a heavy box; `fixWheel` needs two movers holding (one alone never finishes); lights out darkens for 40 s and the breaker clears it; a crew mover pressing `sab` is ignored; a saboteur who disconnects mid-hold leaves no effect; the old bolt trick still works (a saboteur holding to disassemble a desk/table jams it, as today); while pads are stashed, wrapping is refused with a message until refilled; `restrap` (driver only) raises the live safety of a wobbly stack.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(sabotage): eight sabotage actions and their repairs`.

### Task 7: Witnesses, inspection and meetings

**Files:**
- Create: `server/sabotage/evidence.js`
- Modify: `server/sabotage/game.js`, `server/MoveRoom.js` (`callMeeting`, `canCallOut`, `updateMeeting`, `resolveSabotageVote`)
- Test: `test/sabotage-meetings.test.js`

**Interfaces:**
- Consumes: `Bot.prototype.canSeePoint` logic, extracted as `canSee(level, from, to, darkRooms) -> boolean` in `server/sabotage/evidence.js` (bots and witnesses share it).
- Produces: `sab.proof: Map<witnessId, { saboteurId, action, at }>`; `inspect(sab, p, item) -> { tampered: bool, kind?, lastHandlers }`; meeting payload gains `proof`, `inspected`, `log`; player fields `meetingsLeft`, `ghost`.

- [ ] **Step 1: Failing tests** — a crew mover 5 m away with clear sight when a sabotage finishes gets proof naming the saboteur; through a wall or in a dark room: no proof; proof calls a meeting during the 30 s cooldown and with 0 meetings left; reporting a visible burst box calls a meeting once per breakage; a voted-out crew mover becomes a ghost (moves at 0.5, can't vote/call/inspect/witness), a voted-out saboteur is removed; during a meeting holds keep their progress and resume after; lights-out time doesn't run during a meeting.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(sabotage): proof, inspection, meetings, ghosts`.

### Task 8: Endings and the drive-off

**Files:**
- Modify: `server/sabotage/game.js`, `server/MoveRoom.js` (`checkEnd`, `finishRound` results)
- Test: `test/sabotage-endings.test.js`

**Interfaces:**
- Consumes: `sabotageOutcome` (Task 1), `driveOffCheck` (existing).
- Produces: `sab.houseEmpty() -> boolean` (no quota left, no piles, no packed/furniture items outside the truck, nothing carried); results gain `sabotage: { lostValue, houseValue, lossLine, safety, safetyLine, saboteurs: [{id,name}], log }`.

- [ ] **Step 1: Failing tests** — 10 boxes lost and the rest loaded: the truck drives off with empty slots; safety 70 → crew wins, 69 → "Failed inspection: the saboteurs win."; lost value crossing 35% ends it immediately for the saboteurs; voting out both saboteurs → crew wins; a crew mover leaving makes saboteurs ≥ crew → saboteurs win that tick; no timer: `timeLeft` never ends a sabotage round.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS, plus `npm test`.
- [ ] **Step 5: Commit** `feat(sabotage): untimed endings and drive-off rules`.

### Task 9: Fair AI for both sides

**Files:**
- Create: `server/sabotage/bot.js` (Sabotage behaviour mixed into `Bot` when `room.sab`)
- Modify: `server/bot.js` (`think` delegates to the Sabotage brain when `room.sab`; `canSeePoint` uses `canSee`)
- Test: `test/sabotage-ai.test.js`

**Interfaces:**
- Consumes: Tasks 3–7 (`jobsFor`, `ACTIONS`, `REPAIRS`, `canSee`, meetings). AI saboteurs read item `tell`/`shownType` like everyone else and know only their own sabotage history.
- Produces: crew brain (job list → fetch flat box → pack, join a packer within 6 m, repair seen tamper tells, report seen breakages, vote only with proof/inspect/seen-near-break); saboteur brain (works its cover tasks; strikes when no crew mover can see it; average strike interval 45/30/20 s by difficulty; never strikes in a witness's sight on purpose).

- [ ] **Step 1: Failing tests** — fairness: a crew bot's vote never targets a saboteur it has no evidence on (300 seeded votes); an AI saboteur never starts an action while any crew mover `canSee` it; AI never reads `tampered`, `role` or quota bag order (spy proxy on those fields throws if read from the bot module); an all-AI 6-mover game completes (crew or saboteur win) within 20 simulated minutes for 20 seeds.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(sabotage): fair AI crew and saboteurs`.

### Task 10: Client props, room meters and darkness

**Files:**
- Modify: `client/src/voxel.js` (models: `flatstack`, `flatbox` (folded cardboard), `pile` (loose items + torn cardboard), `padcrate`, `breaker`, light switch on each room wall), `client/src/scene.js` (render tells: sagging weak boxes, dangling tape, wobbly wheel, frayed pads; dark rooms; ghosts see-through; room meters as floor decal "3/7"), `client/src/main.js` (minimap meters: Foreman all rooms, others current room)
- Test: `test/e2e-sabotage.mjs` (props and meters part)

- [ ] **Step 1: Write the e2e** — start a 6-mover all-AI Sabotage game; assert the stack, crate and breaker exist in the snapshot and render without page errors; screenshot a room meter and a dark room (via a debug `debug_sab` hook that applies an action instantly, test-only).
- [ ] **Step 2: Run** `node test/e2e-sabotage.mjs` against a `DEBUG_HOOKS=1` server — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS; check screenshots by eye.
- [ ] **Step 5: Commit** `feat(sabotage): props, tells, room meters, dark rooms`.

### Task 11: Client UI — roles, sabotage button, jobs, meetings, results

**Files:**
- Create: `client/src/sabotage-ui.js`
- Modify: `client/index.html`, `client/src/input.js` (bind `sabotage` default `KeyG`, pad `LB` shares with call-out → use `RT` index 7), `client/src/main.js`, `client/src/style.css` (UI kit styles)
- Test: `test/e2e-sabotage.mjs` (UI part), `test/e2e-controls.mjs` (new bind listed)

- [ ] **Step 1: Extend the e2e** — role card shows on start; with 2 saboteurs each sees the other with a red outline (nobody else does); the Driver sees a live safety % chip (with 4 movers everyone does); the sabotage button appears only for saboteurs (phone viewport); job list chip shows 3 jobs; a meeting shows a proof card and the work log; results show the 35% and 70% lines and names the saboteurs; all menus still fit (no element cut) at iPhone 13 and 1280×720.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; lobby: Sabotage shows "Crew 4–6" and sets crew size 6 by default; game description updated.
- [ ] **Step 4: Run** the e2e and `e2e-controls`, `e2e-meeting`, `e2e-wave2` — PASS.
- [ ] **Step 5: Commit** `feat(sabotage): role card, sabotage button, job list, meeting evidence, results`.

### Task 12: Balance pass

**Files:**
- Create: `tools/sabsim.mjs` (runs N all-AI 6-mover games headless; prints crew win %, saboteur win split by reason, median length)
- Modify: `shared/sabotage.js` (tuned values only)
- Modify: `docs/superpowers/specs/2026-11-28-sabotage-packing-design.md` (record final values)

- [ ] **Step 1: Run** `node tools/sabsim.mjs 200 normal` — record the baseline.
- [ ] **Step 2: Tune** `SAB` values (and AI strike intervals) until: crew wins 45–60%; each saboteur win reason ≥10% of saboteur wins; median game 8–14 simulated minutes. Also check easy/hard move the crew win rate the expected way.
- [ ] **Step 3: Run** `npm test` and the sabotage e2e — PASS.
- [ ] **Step 4: Commit** `balance(sabotage): tuned values from 200-game simulation`.
