# Sabotage: Pack the House (design)

Date: 2026-11-28 · Status: draft for approval

## Why

Today's Sabotage is Full load with one hidden saboteur: the same loose cargo, one secret trick (over-tightening bolts) and a
vote. It plays like the competitive game with a twist. The owner wants a fuller, different game type built for **6 players**:
more reasons to **group up**, more **chances to sabotage**, more ways to get caught, and no clock. The fun moments it should
produce: catching someone in the act, a box bursting in someone's arms, a heated vote, a narrow drive-off above the safety bar.

## Goals

- A distinct game: the crew **packs the house** room by room, then loads the truck. Nothing starts boxed.
- Jobs that are faster (or only possible) **in pairs**, so people cluster and alibis exist.
- Many small, varied sabotage actions, each with a way to be **noticed**, **repaired** or **investigated**.
- **Untimed**: the round ends when nothing is left in the house to load, or when the saboteurs win.
- Fair AI on both sides: AI movers only act on what they can see; no hidden information.
- Balanced for 6 (2 saboteurs); still playable with 4–5 (1 saboteur). AI fills empty seats.

## Non-goals

- No changes to Competitive, Full load or Teams. (Approach below.)
- No new character art beyond what this needs (flat-box stack, piles, a breaker box, a padding crate).
- No voice/text chat changes beyond showing meeting evidence.

## Anti-goals (would make it a failure even if it works)

- A round that **stalls** forever (nothing left to do but nobody can finish).
- Sabotage that is **invisible and unanswerable** (no tell, no repair, no investigation).
- AI that **cheats**: AI crew that knows who the saboteur is, AI saboteurs that know who is watching from across the house.
- Meeting spam that stops the game.

## Approaches (decided)

1. **A separate Sabotage game built on the shared base** ← chosen. Reuse movement, carrying, dollies, the truck grid,
   meetings and voting; replace house setup, packing, breakage, sabotage actions, roles and the endings. Other modes untouched.
2. Add it inside the existing rules with "if sabotage" checks: quick start, but the room code (~1,800 lines) gets riskier
   for every mode with each change.
3. Build packing for all modes first, then layer Sabotage: most flexible, biggest job, changes modes the owner likes.

Owner picked 1.

## The round, start to finish

1. **Lobby**: Game = Sabotage. Crew size 4–6 (default 6). AI fills seats. Teams are off.
2. **Roles** are dealt (secretly where noted) — see Roles.
3. **Pack phase and load phase overlap**: there is no hard switch. Rooms get packed; packed boxes and furniture get carried
   to the truck as soon as they exist.
4. **End**: when nothing is left in the house to load, the truck drives off (see Endings). Or the saboteurs win first.

## The house

- Generated as today (`exact: true` sizing so everything packed fits the 4×4×4 truck exactly, 64 cells), then converted:
  - **Furniture stays** where generated (couch, bed, desk, table, dresser, armchair, TV, lamp, bookshelf, coffee table).
  - **Loose boxes are removed.** Their cell count becomes **box quotas** spread across rooms.
- **Quota per room**: box cells (64 − furniture cells) split over non-hall rooms by floor area, at least 1 each.
  Halls, passages and stairs get none.
- **Room meter**: each room shows "Kitchen 3/7 packed" (floor decal + a small bar on the minimap). Full = room done.
- **Box type mix per room** (owner's call for the first five; the rest are the builder's guesses from typical contents):

| Room | Standard | Heavy | Fragile |
|---|---|---|---|
| Kitchen | 25% | 15% | **60%** |
| Bathroom | 0 | 0 | **100%** |
| Living room | 45% | 30% | 25% |
| Office | 30% | **45%** | 25% |
| Bedroom | 55% | 15% | 30% |
| Dining room | 50% | 30% | 20% |
| Garage | 35% | 65% | 0 |
| Laundry | 55% | 40% | 5% |
| Kids room / Playroom | 75% | 5% | 20% |
| Family room (den) | 60% | 25% | 15% |
| Storage | 50% | 45% | 5% |

  Types are drawn per room at house generation (a shuffled bag that matches the mix), so a room's total is known but the
  next box's type is revealed only when it's packed.

## Packing

- **Flat-box stack** by the ramp: unlimited. Tap it to pick up one flat box (light, carried like a standard box).
- In a room with quota left, **hold ACTION** with a flat box to pack it:
  - **Alone: 7 s.** **With a partner** (a second mover, empty-handed, holding ACTION within 1.5 m of the packer): **3 s.**
    Both get credit and a work-log entry. Repairs marked "two movers" work the same way.
  - Finishing turns the flat box into a packed box of the room's next type (mark on all four sides) and ticks the meter.
- Packed boxes behave like today's boxes (carry, dolly, furniture dolly, stacking rules, crushing, the truck grid).

## Breakage (permanent)

- Broken things **never respawn**. Their value counts as **lost**.
- A **packed box bursts** when it breaks (crushed, dropped off a dolly, sabotaged — see below):
  - Fragile box: contents are **lost** (one quota slot gone for good).
  - Standard or heavy box: contents spill into a **pile** on the floor. Hold ACTION over the pile with a flat box to repack
    it: **5 s alone / 2.5 s with a partner**. The new box is **marked fragile** (it scores and stacks as fragile).
  - **Comeback**: a pile repacked within **10 s** keeps full value; after that its value falls linearly to **50% at 40 s**,
    then stays at 50%. Lost value counts toward the saboteurs' damage total.
- **Furniture**:
  - Falling off a dolly (either kind) = **damaged**: worth **50%**, and counts against drive-off safety.
  - An unwrapped wrap-needing piece is still scuffed at loading, as today.

## Sabotage actions

The saboteur gets a **Sabotage** button (phone: a separate button that only saboteurs see; keyboard: its own key, default
`G`). It acts on what's in reach, like the action button. **One sabotage every 20 s** (shared cooldown per saboteur).
Each action takes a short hold, during which the saboteur stands still.

| Action | Target | Hold | Effect | Tell | Fix / answer |
|---|---|---|---|---|---|
| Weaken flat boxes | the flat-box stack | 2 s | the next 3 flat boxes taken are weak; a box packed from one has a 35% chance to burst when first lifted, and 2% per second while carried | weak boxes sag slightly | Inspector can spot it; repack piles |
| Cut tape | a packed box | 1.5 s | bursts the next time it's lifted (contents spill) | a dangling tape strip | re-tape: hold ACTION 2 s (anyone) |
| Mislabel | a packed fragile box | 2 s | its marks show ↑↑ standard, so movers may stack heavy things on it, but it is still fragile and gets crushed (the aiming outline also shows it as standard) | none (that's the point) | Inspector reveals and relabels it |
| Loosen wheel | a dolly (either) | 2 s | its load wobbles off 3× faster; pushing it makes it pull to one side | a wobbling wheel, a squeak | **two movers** hold ACTION at the dolly 3 s |
| Snag the pads | a piece of furniture | 2 s | wrapping it takes 2× as long | frayed pad visible | none; just slower |
| Stash the pads | the padding crate by the ramp | 2 s | nobody can wrap for 30 s | crate shows empty | anyone refills it from the garage shelf (hold 2 s) |
| Lights out | a room's light switch | 1.5 s | the room goes dark for 40 s: dim view, no see-through silhouettes in it, AI sight there cut to 2 m | the room is dark | flip the breaker (garage or laundry) |
| Pull from the truck | a piece in the truck | 2.5 s | takes the top piece out and drops it on the ramp side (it must be reloaded) | the load count drops | reload it |

Rules for all: no sabotage during a meeting; no sabotage in the truck while another mover is within 3 m of the ramp;
the old "over-tighten bolts" still exists for desks and tables (the hold-to-disassemble "help" trick).

## Getting caught

- **Witness**: if a crew mover can **see** the saboteur (same rule AI sight uses: within 9 m, not through walls, room lit)
  while a sabotage hold **finishes**, that mover gets **Proof** ("📸 You saw Nova cut the tape").
  - Proof lets them call a meeting **any time**, even with no meetings left or during the cooldown.
  - The meeting screen shows the proof card to everyone. Voting still decides (a witness can lie by omission, and AI
    witnesses don't fabricate).
- **Inspect** (Inspector role): hold ACTION 2 s on a box, pile, dolly or furniture piece: reveals whether it's tampered, and
  the **last two movers who handled it**. 20 s cooldown.
- Every pair job (packing together, repairs) adds to a shared **work log** visible in meetings: "Kai + Nova packed in the
  kitchen at 2:10". Alibis come from this.

## Meetings

- Called by: anyone with an **emergency meeting** left (**1 each**, the Foreman has 2), anyone holding **Proof**, or by
  **reporting a burst box / broken piece** you can see (once per breakage).
- **30 s cooldown** after a meeting (as today). Proof ignores it.
- **Truck lock**: during a meeting everything freezes, including the truck and every hold in progress (holds resume after).
  With no clock, a meeting costs only the players' attention; the limits above keep it from being spammed.
- Vote as today (highlight, Submit, skip). The most votes is out; a tie or skip = nobody.
  - Voted-out **crew** become **ghost movers**: see-through, can carry and pack at half speed, can't vote, call meetings,
    inspect, witness or sabotage.
  - Voted-out **saboteur**: out for good (no ghost). Announced.

## Roles

- **Saboteurs**: **2** with 6 movers, **1** with 4–5. With 2, they **know each other** (shown with a red outline to each
  other). Each saboteur sees **cover tasks**: a job list that looks exactly like a crew job list ("Re-tape the garage boxes",
  "Pack 2 in the office") so they always have a reason to be somewhere.
- **Foreman** (crew, public): sees every room meter, has 2 emergency meetings.
- **Inspector** (crew, public): has Inspect.
- **Driver** (crew, public): sees the live safety % of the load; only the Driver can **re-strap** a wobbly stack in the
  truck (hold 3 s) to win back safety. If the Driver is voted out, the role passes to a random living crew mover.
- Everyone else: **Mover**.
- Role cards are dealt in that order (Foreman, Inspector, Driver) to crew movers; with 4 movers there's no Driver
  (safety % is shown to everyone instead).
- **Job list** (crew): 3 suggested jobs at a time, from the house's actual state ("Pack the bathroom: 2 left",
  "Fix the dolly", "Re-tape the box in the hall"). Purely guidance.

## Endings (owner's option 3)

House value **V** = sum of all furniture values + all quota boxes' values (at generation).

- **Saboteurs win** if:
  - **Lost value ≥ 35% of V** (broken + damaged shortfall + pile decay), or
  - living saboteurs **≥** living (non-ghost) crew.
- **Crew wins** if:
  - **every saboteur is voted out**, or
  - **nothing is left in the house to load** and the drive-off **safety ≥ 70%**.
- **Drive-off**: when no unpacked quota, no piles, no packed boxes and no furniture remain outside the truck, the truck
  closes up and drives off **even if the truck has empty slots** (things that broke are gone; nothing is left to load).
  Safety is checked as today (shifting, crushing, wobbly towers). Below 70% → "Failed inspection: the saboteurs win."
- No timer anywhere. Overtime drain from the old Sabotage is removed.

## AI (fair play)

- AI crew: work the job list, pair up when someone is packing nearby, repair what they **see** broken or tampered,
  report breakages they **see**, vote only with evidence (Proof, an Inspect result, being seen near a breakage).
- AI saboteurs: do real work most of the time (cover), sabotage only when **no crew mover is within its own sight**
  (same 9 m / walls / lights rule), prefer actions near other movers' work, never sabotage in front of a witness on purpose,
  call fake reports rarely. They know their partner (as a human would).
- AI never reads hidden state: not the role of others, not tampered flags (except an AI Inspector's own inspect results),
  not box types before packing.
- Difficulty (Easy/Normal/Hard) scales AI speed, how often AI saboteurs strike (every 45 s / 30 s / 20 s on average) and
  how carefully AI crew watch others.

## Balance targets (the builder tunes these)

- A 6-mover all-AI Normal game should take **8–14 minutes**.
- Over 200 simulated all-AI games on Normal: crew win **45–60%**; saboteurs win by damage, by outnumbering and by failed
  inspection each happen in at least 10% of saboteur wins.
- Starting values: everything in the tables above. Tune with a simulation tool like the existing `tools/aidiag.mjs`.

## UI (new bits)

- Flat-box stack model by the ramp; pile model (loose items + torn cardboard); padding crate; light switch per room; a
  breaker box in the garage or laundry.
- Room meters on the minimap (Foreman sees all; others see the room they're in).
- Saboteur button (phone) and cover tasks; role card at round start; job list chip under the HUD.
- Meeting screen: proof cards, inspect results shared by the Inspector, the work log (last 6 entries).
- End screen: damage total vs the 35% line, safety vs the 70% line, who the saboteurs were and what they did (a short log).

## Constraints

- Server is authoritative (as today). All new state lives on the server; clients only render.
- Must run on phones (the touch controls get one extra button only for saboteurs).
- Debug hooks for tests stay test-only.

## Calls made in writing this (owner to check)

- Thresholds: saboteurs win at **35%** of the house's value lost; the crew must drive off at **70%** safety or better.
- Proof doesn't convict on its own: it lets the witness call a meeting any time and shows everyone the card; the vote decides.
- With 2 saboteurs, they know each other.
- Sabotage needs **4–6** movers (1 saboteur at 4–5, 2 at 6); AI fills empty seats.
- Ghost movers (wrongly voted-out crew) keep working at half speed but can't vote, call meetings, inspect or witness.
- One emergency meeting each (the Foreman has 2), plus reports and proof.
- No individual scores decide Sabotage: it's crew vs saboteurs. The end screen still shows awards (most packed, best
  partner, most repairs).

## Left to the builder

- Exact models and colours for the new props (match the game's voxel style and UI kit).
- How the Sabotage room code shares the base (subclass or composition) as long as other modes are untouched.
- Tuning values within the balance targets.
- Unit tests for each action, repair, ending and AI fairness rule; an e2e for a full 6-mover AI round.
