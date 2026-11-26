# Share image

`client/og.html` + `client/src/og.js` draw `client/public/og.png` (1200×630) with the game's own code: the real house, truck,
astronauts, crew, cardboard boxes (with their glass / anvil marks) and the night sky. They are not part of the game build.

    npx vite client --port 5199          # dev server (leave it running)
    node tools/og/render.mjs             # writes client/public/og.png  (optional: [out.png] [house seed])

Social sites cache link previews: after a new image, re-scrape the link (e.g. Facebook's Sharing Debugger) to refresh it.

## App icons (Home Screen, favicon)

`client/icon.html` + `client/src/icon.js` draw Nova holding a box on the orange background. With the dev server up
(`npx vite client --port 5199 --strictPort`), run `node tools/og/icons.mjs`. It writes `client/public/icon-512.png`,
`icon-192.png`, `apple-touch-icon.png` (180), `favicon-32.png`, and the pulled-back `icon-maskable-{192,512}.png`
that Android crops to a circle.
