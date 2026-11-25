# Round 11: real homes, multiple floors, a redesign that doesn't look generated

Date: 2026-11-25 · Status: approved to build (owner said "do what you think is best")

## Why
The owner wants Let's Move It to look and feel like a real, cared-for game for Starside Movers' customers, not "AI slop":
houses that read like actual homes, more detail, and a UI that follows the owner's own design rules (DESIGN.md in
Tennoform and MealTote, plus the Markdown Guidance Library). Share links should sell the game at a glance.

## Owner's rules applied (from Tennoform/MealTote DESIGN.md + guidance library)
- Warm neutrals: warm charcoal (dark) / warm off-white surfaces, greys with no blue. **No navy, indigo or purple backgrounds, no neon,
  no rainbow gradients.** Accent: Starside orange, gold for highlights, mint only for "go/confirm" states.
- Real type pairing: one display face for headings and big numbers, one plain sans for text. Left-aligned text, no centered paragraphs.
- Lists over walls of cards; a card only when it's acted on as a unit (a mover in the carousel, the booking card).
- Status is text and outline, never a filled card. Every control has a word on it. Say what a number means next to it.
- No stock phrases. Don't invent numbers.
- Phones first: 40 px targets, bottom sheets, 16 px inputs. Motion short and rare; respect prefers-reduced-motion. WCAG AA.
- Design every state (loading, empty, error, disconnected). Verify in a real browser at phone and desktop sizes.

## Goals
1. **Share image**: 1200×630 og.png showing the voxel crew carrying boxes in front of a house and the truck, warm night palette,
   game name + "a moving-day party game by Starside Movers".
2. **Homes that read like homes**:
   - Room roles from position: the room with the front door is the Living Room; Dining is next to Living; Kitchen next to Dining;
     Bedrooms are the rooms furthest from the front door (and upstairs); then Bathroom, Office, Laundry, Garage (ground floor only).
   - Furnishing rules: every Bedroom has one bed + one dresser; Dining has a table + a lamp; Living has a couch + a lamp + a coffee
     table; Office has a desk; boxes are scattered through every room (more in bigger rooms), fragile ones favour the Kitchen and
     Dining room, heavy ones the Garage and Office.
   - New pieces: **Dresser** (1×1×2 standing, heavy, needs wrapping, 35 pts) and **Coffee Table** (2×1×1, 25 pts). Both are solo carries.
   - Each room type has its own tile set: floor pattern + wall colour on that room's side of every wall + skirting colour.
   - The whole inventory still fits the 64-cell truck (furniture is capped; extra rooms get boxes instead).
3. **Floors (1–4)** chosen by the crew chief in the lobby. Stairs connect each floor to the next. Items are spread across floors in
   proportion to floor area. The truck and front door are on the ground floor.
4. **UI redesign** of sign-in, menu, lobby, HUD, results and settings under the rules above, using 21st.dev components as reference.
5. **More detail**: dresser and coffee-table models, windows and doors on the house, wall decor, fences/hedges, a warm night sky.

## Non-goals
- No change to scoring, the truck grid, or modes. Classic look keeps working (and gets floors) but gets no new art.
- No full 3D physics; floors are a rendering + navigation concept (below).

## Anti-goals (failure even if it "works")
- Purple/indigo washes, neon glows, card grids, icon-only buttons, centered paragraphs, bouncing/looping motion.
- Stairs that teleport visibly, or a mover/item that can end up "between" floors or in a wall.
- Phones getting slower than today on /voxel (draw calls must stay below the classic look's).

## Approaches considered for floors
1. **True 3D positions (x, y, z) everywhere** — rewrite collision, nav, separation, AI and every distance check. Large, risky, no visible gain.
2. **Separate rooms reached by "doors" to other maps** (teleport between unconnected maps) — cheap but doesn't look like a house.
3. **Chosen: stacked floors laid out side by side on the server.** Floor *k* lives in its own strip of the flat map at z + 40·k
   (the ground floor is today's map). Collision, nav, AI and item code stay 2D and unchanged. The browser draws floor *k* at
   height 3.2·k in the same footprint. A staircase is a ramp rectangle that exists on floor *k* (going up) and on floor *k+1*
   (going down); crossing its middle moves you between strips at the same drawn position, so on screen it's a smooth climb.
   The nav grid grows to cover all strips and gets portal links across each staircase so bots plan multi-floor routes.

## How floors work (decided)
- Server: `level.floors` (1–4), `level.floorOf(z)`, `level.stairs[] = {k, x0, x1, z0, z1}` (in floor-0 coordinates; up from k to k+1,
  ramp rising toward +x). Rails (thin walls) on the ramp's long sides; on the upper floor the low end is closed (stairwell edge).
  Crossing into the upper half on floor k → z += 40; crossing into the lower half on floor k+1 → z −= 40. Carried items, team
  lifts (item + both carriers), dollies move with you. World perimeter walls keep the strips sealed from each other.
- Client: a single `toRender(x, z)` maps server positions to drawn positions (z − 40·k, y = 3.2·k + ramp offset).
  Floors above the viewer's floor are hidden; the camera follows the viewer's height; the minimap shows the current floor with
  a "Floor 2 of 3" label; items/movers on other floors are hidden in the 3D view and listed on the minimap edge.
- Lobby: "Floors: 1 · 2 · 3 · 4" control (crew chief). Default 1. Daily house picks 1–2 from its seed.

## Left to the builder
Exact model choices for dresser/coffee table/decor (CC0/CC-BY, credited), exact colours of each tile set within the palette,
typeface choice (display + text, free web fonts), where stairs sit within a room (not in doorways, not over items).
