# Solo vs AI + Quality-of-Life Pass — Design

## Intent
The user asked for three things: play the live game and fix what's rough, a **single-player mode: you vs 3 AI movers**
with a **difficulty setting**, and more QoL/UI polish. Solo mode also makes the game playable when no friends are online,
which matters for an email-gated funnel: one person should be able to clock in and have fun right away.

## Solo vs AI
- Home screen: **"🤖 Solo vs 3 AI"** next to "Start a new crew". Picking it creates a private room with 3 AI movers already in the crew.
- **Difficulty: Easy / Normal / Hard**, chosen in the lobby by the host. It applies to every AI mover and can be changed before each round.
- Hosts of a normal crew can also **add or remove AI movers** to fill empty seats (same difficulty setting), so 2 friends + 2 bots works too.
- AI movers are server-side players that go through the **same simulation** as humans: same speed rules, same carry, same load mode.
  They produce inputs and never teleport or cheat, with one shortcut: in load mode they set the cursor directly instead of steering it.

### AI behavior by difficulty
| | Easy | Normal | Hard |
|---|---|---|---|
| Walk speed | 70% | 88% | 100% |
| Reaction delay | 0.9–1.6 s | 0.4–0.9 s | 0.15–0.4 s |
| Stacking | random valid column, crushes happen | sensible, 25% sloppy | best spot: heavy low, fragile high, never crushes |
| Wraps couch/lamp first | 30% | 70% | always |
| Helps with 2-mover lifts | sometimes | yes | yes, prioritizes |
| Call-outs after a crunch | rarely | sometimes | usually |
| Votes for the real culprit | 35% | 60% | 85% |
| Dash | never | on long walks | on long walks |

- A bot that caused a crunch never calls a meeting and votes for someone else (it bluffs).
- Bots chat short canned lines in meetings ("I saw Glorp at the truck!", "Wasn't me, I was in the kitchen").
- Pathfinding: A* on a 0.5 m walkability grid built from the wall layout, recomputed when the target changes.

## QoL / UI fixes (from playing the live build)
1. **Spawns overlap.** Movers start stacked and their name tags merge. Spread spawns and add soft mover-to-mover separation.
2. **Round countdown** (3-2-1-GO) so nobody starts mid-sentence.
3. **Truck progress** in the HUD: `🚚 4/29 loaded`, plus items left.
4. **Guidance arrow**: when carrying, an arrow at your feet points to the load zone. When empty-handed, it points to the nearest item.
5. **Column heights** on the truck grid in load mode, so you can plan without rotating the camera.
6. **Strikes** read as `Strikes 0/2` instead of ambiguous hearts.
7. **Sound toggle** (🔊/🔇), remembered per device.
8. **Phone lobby chat** collapses behind a 💬 button so it no longer covers the lobby card.
9. **Reconnect**: if a phone drops mid-round, it rejoins its own mover for up to 30 s instead of becoming a spectator.
10. **Results**: highlight "you", show each mover's breaks and the AI difficulty.

## Non-goals
- Bots learning or adapting between rounds.
- Matchmaking with strangers.

## Approaches considered
1. **Server-side bots that emit inputs (chosen).** One simulation path, so they can't desync. Bots also work in mixed crews.
2. Client-side bots in the solo player's browser. No server cost, but it splits the logic and breaks mixed crews.
3. Bots that move by direct state edits. Simpler, but they'd walk through walls and feel unfair.

---

## Addendum — wave 2 (requested mid-build)
- **Shaped furniture**: couch 3×1×1 (stands 3 high), bed 2×3×1, floor lamp "r" (3 cells: 2-high pole + arm). Every piece can be turned and flipped into all of its distinct orientations (lamp: 12).
- **Procedural houses** every round (seeded, identical on every client): 3–6 rooms, size and yard distance vary. Lobby shows the house; host can re-roll.
- **Broken items respawn** somewhere in the house as a fresh item, in every mode. The break still counts for call-outs.
- **Truck full ends the round** in timed modes as soon as nothing left in the house fits.
- **Full load (🧩)**: the house holds exactly one truckload (64 cells), built by packing the truck first, so it's always solvable without crushes. The round ends only on a perfect load. Hold ACTION on the ramp to pull the top piece off a stack and repack (points come back off whoever loaded it). Unloading is Full load / Sabotage only so it can't be used to steal points.
- **Sabotage (🕵️)**: 3+ movers, Full load house, one secret saboteur (told privately; never in the shared snapshot). Crew wins on a perfect load or by voting out the saboteur. When time runs out the crew score drains; at zero the saboteur wins. Saboteur's hold on an assembled desk/table looks like disassembling but jams the bolts (+up to 8 s). Meetings any time (20 s cooldown per caller). A wrong vote ejects that innocent mover. No strikes.
- **AI in Full load** follows the known packing (Hard always, Normal 80%, Easy 45%), sets aside pieces that can't go in yet, and pulls misplaced/gap-making pieces back out when the truck gets stuck. **AI saboteur** crushes on purpose, jams furniture, sometimes packs correctly to blend in, and bluffs in meetings. **AI crew** build suspicion from crunches they "see" and vote on it.
- **Multiplayer**: disconnect notices in chat; 30 s reconnect; if everyone else leaves mid-round, the last human wins by default. 🆘 help ping for two-mover lifts. Phone truck aiming uses a D-pad and drag; the drop stays on the ✋ button.
