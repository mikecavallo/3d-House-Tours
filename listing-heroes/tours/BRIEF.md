# Tour pages: builder brief

Five single-listing pages built from scraped 360 tours (Ricoh360). Each page is a sales demo for a business that
sells AI-built listing pages to realtors. The owner asked for pages that are jaw-dropping and **very different from
each other**, using design principles that are rarely seen on real-estate sites. One house, one idea, executed fully.

## Files

- `engine/pano.js`: shared WebGL2 360 engine (read it, it is short). Global `PanoKit = {Pano, Tour, basis, dirOf, wrapPi, clamp, ease, easeOut, lerp, D2R}`.
- `media/<slug>/NN.jpg` (4096x2048 equirect, graded) and `NN-sm.jpg` (1024x512). A few rooms are flat photos (see `flat`).
- `media/<slug>/layout.json`: `{name, address, photographer, description, rooms:[{i, name, heading, x, y, comp, flat, links:[{to, yaw, pitch}], notes:[{title,text,yaw,pitch}]}]}`.
  `links` are the real door hotspots: in room `i`'s panorama, room `to` is at `yaw` (radians, + = right, 0 = image center) and `pitch`.
  `heading` is solved so walking keeps your direction; rooms in the same `comp` share headings. x/y are rough and multi-floor; do not present them as a floor plan.
- `data/<slug>/tour-data.json`: raw tour data if you need more.
- `pages/<slug>/index.html`: **your page**. Optional `pages/<slug>/assets/` for generated images (orbs, posters).
- `build.py <slug>` bundles to `dist/<slug>/` (engine inlined, media path set). `dist/<slug>/preview.html` is the local preview.
- `tools/shot.mjs` screenshots desktop + phone: `cd tours && node tools/shot.mjs http://localhost:8765/dist/<slug>/preview.html /tmp/<slug> "0,0.25,0.5,0.75,1" 5000`
  A static server already runs on port 8765 with `tours/` as root (if not: `cd tours && python3 -m http.server 8765 &`). Playwright resolves from `/opt/node-tools/node_modules` (run node with `NODE_PATH=/opt/node-tools/node_modules` or symlink node_modules). Rendering is software WebGL: slow but correct.

## Engine API (short)

```js
const MEDIA = window.MEDIA_BASE || '../../media/<slug>';   // exactly this line, build.py relies on it
const L = await (await fetch(MEDIA + '/layout.json')).json();
const pano = new PanoKit.Pano(canvas, { fov: 80, look: { vig: .2 } });   // canvas sized by CSS; resizes itself
const tour = new PanoKit.Tour(pano, L, MEDIA, { auto: 0.02 });            // auto = idle yaw drift rad/s
await tour.show(roomIndex, yaw, pitch);  // instant
tour.attach(canvas);                      // drag look, wheel zoom (opts.wheelZoom:false to disable)
pano.onframe = t => { tour.idle(dt) ... } // your per-frame hook (compute dt yourself)
await tour.walk(j)   // dolly through the door to linked room j (heading-correct). Falls back gracefully.
await tour.cut(j, yaw)   // crossfade to any room
pano.A / pano.B layers: {yaw, pitch, roll, k (0 lens .. 1 little planet), off:[x,y,z] camera offset inside the sphere (|off|<1), blur}
pano.alphaB (0..1 blend to layer B), pano.fov (deg)
pano.look: {expo, sat, warm, vig, grain, develop (0..1 sepia albumen print), lineAmt (0..1 ink line drawing of layer A),
            spot:[x,y,r] (screen uv; inside r the photo shows through the drawing), spotSoft, tint, tintAmt, nadir (tripod cap)}
pano.project(yaw, pitch) -> {x,y} px or null ; pano.pick(px,py) -> {yaw,pitch}
pano.load(url, smUrl) -> handle {promise (preview ready), fullPromise}; pano.set(pano.A, handle)
```
Flat photos (`flat:true` rooms) render as a cover-fit plate automatically when set on a layer.

## Page contract (the Artifact host)

- Write a page body: start with `<title>` then `<style>`, then markup and scripts. **No** `<!doctype>`, `<html>`, `<head>`, `<body>`.
- Load the engine with exactly `<script src="../../engine/pano.js"></script>` before your inline script.
- Fonts only from Google Fonts (`<link>` to fonts.googleapis.com), always with fallback stacks. No other external hosts (no images, no CDNs except cdnjs/jsdelivr/unpkg scripts, which you should not need). No iframes.
- No `alert/confirm/prompt`, no `window.print`, no `mailto:` reliance. A contact form handles submit in JS (`preventDefault`) and shows an in-page confirmation that says the request was noted (it does not claim an email was sent).
- Theme: define colors as CSS tokens on `:root`. A page may deliberately commit to one look (dark or light): then set `color-scheme` and every color explicitly and skip the dark blocks. Otherwise give `:root` light values and redefine for `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){...}}` and `:root[data-theme="dark"]{...}`. `body` sets an explicit background.
- Works at 390px phone width (no horizontal scroll, 16px side gutter for text). Touch drag works (pointer events). `prefers-reduced-motion`: no auto drift, cuts instead of dolly, no scroll-jacking.
- Must show something readable in the first frame (title, address) even before WebGL textures arrive: style a poster state.
- Keep the first paint light: load `-sm` first (the engine does this), never preload all 4096 images; prefetch only neighbors (Tour does).

## Content rules

- Facts only from layout.json / tour-data.json (name, address, description, room names, dimensions in room names, annotations). Never invent price, beds/baths counts not stated, agent names, brokerages, phone numbers or emails.
- Every page carries a small honest footer line: "Concept demo built from the property's 360 tour. 360 photography: <photographer>." Credit the photographer by name.
- The contact block is generic: "Book a private showing" style, fields name/email/message, no fake agent identity.
- On-screen copy: short, plain, human. **No em dashes or en dashes anywhere** (use commas, periods, colons). No "Furthermore", no filler. Room names: clean them up for display (e.g. `Bedroom2` -> `Bedroom 2`, strip dimensions into a separate data label where the concept uses them).
- Accessibility: visible focus states, buttons are buttons, alt/aria-labels on the canvas controls.

## Quality bar

This is the portfolio piece. Typography must be deliberate (a display face you would not use on other projects, a body face, maybe a utility face), a token palette drawn from the actual house, and **one** bold idea executed with care rather than many effects. Avoid generic AI looks: cream + terracotta serif, purple gradients, Inter/Space Grotesk, emoji, centered-everything, rounded cards with shadows everywhere.
Before you finish: build, screenshot desktop + phone at several scroll positions, look at every screenshot, fix what is off (overlaps, clipped text, unreadable contrast over imagery, dead first frame, broken transitions), and screenshot again. Check the console output for errors. Iterate until it is genuinely striking.
