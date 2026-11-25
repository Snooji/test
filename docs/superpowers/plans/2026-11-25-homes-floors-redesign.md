# Plan: real homes, floors, redesign (round 11)

Spec: docs/superpowers/specs/2026-11-25-homes-floors-redesign-design.md. Each phase ends with unit tests + browser suites on both
links, a commit and a push. TDD for server/shared logic (write the failing test first).

## Phase 1: share image
- [ ] Render scene with voxel crew (glb) carrying boxes, house + truck behind, warm night sky; 1200×630 → client/public/og.png
- [ ] Check meta tags point at it (og:image, twitter:image); verify the file renders

## Phase 2: homes (shared/level.js, shared/logic.js, client)
- [ ] Test: new item types dresser + coffeetable have shapes/points and fit the truck rules
- [ ] Test: room roles (front-door room = Living; Dining adjacent to Living; Kitchen adjacent to Dining; bedrooms furthest)
- [ ] Test: furnishing (each bedroom bed+dresser, dining table+lamp, living couch+lamp+coffeetable), inventory ≤ truck capacity,
      boxes in every room, nothing in doorways
- [ ] Implement roles + furnishing + per-role tile sets (floor pattern, wall colour per side, skirting)
- [ ] Models: dresser + coffee table (Sketchfab CC-BY/CC0, compressed), classic fallbacks; credits
- [ ] AI handles new pieces (generic); sims still load ≥ previous

## Phase 3: floors
- [ ] Test: generateLevel(seed, {floors:n}) → n strips, stairs between consecutive floors, rails, items on every floor
- [ ] Test: walking up/down a staircase moves z by ±40, never into a wall, carried item/team lift/dolly follow; no visible jump
      (render-space distance per tick ≤ walking step)
- [ ] Test: nav finds multi-floor paths; bots fetch items upstairs and bring them to the truck
- [ ] Server: options.floors, lobby message, snapshot level descriptor, nav bounds + portals
- [ ] Client: toRender mapping (players, items, cat, pings, arrow, camera), per-floor house groups, hide floors above,
      stair ramps + stairwell holes, minimap per floor, lobby control

## Phase 4: UI redesign
- [ ] Tokens (warm charcoal/off-white, orange/gold accents, type pair), remove purple/indigo washes from UI and world
- [ ] Rebuild sign-in, home menu (list rows), lobby (sections as lists, segmented controls with words), HUD, results, settings
- [ ] States: loading, empty, error, disconnected; reduced motion; AA contrast check (axe) at phone + desktop

## Phase 5: detail
- [ ] Windows/doors on exterior walls, wall decor, hedges/fences, warm night sky; keep draw calls < classic
