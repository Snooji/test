# Share image

`client/og.html` + `client/src/og.js` draw `client/public/og.png` (1200×630) with the game's own code: the real house, truck,
astronauts, crew, cardboard boxes (with their glass / anvil marks) and the night sky. They are not part of the game build.

    npx vite client --port 5199          # dev server (leave it running)
    node tools/og/render.mjs             # writes client/public/og.png  (optional: [out.png] [house seed])

Social sites cache link previews: after a new image, re-scrape the link (e.g. Facebook's Sharing Debugger) to refresh it.
