# 3D House Tours

Five property sites and the Five Houses hub that links them, plus the tour data and the listing-hero pipeline behind them.

| Folder | What it is |
|---|---|
| `sites/` | The hub (`sites/index.html`) and one static site per house: Sun-Drenched Production Space, Vine Leaf Residence, 47 Ross Avenue, The Mission House, The Noe Valley Victorian |
| `tours/` | Per-house tour data: 360° panoramas, layout, tour-data.json, floor plans, thumbnails, source image lists |
| `listing-heroes/` | The listing-hero pipeline, story pages and hero images (copy of `mikecavallo/listing-heroes`) |

Serve the repo root with any static host and open `/sites/`. Each house's raw 360° panoramas are in `tours/<house>/pano/`.

## Open it locally

Browsers block the tour code on `file://` links, so double-clicking the HTML shows folder listings or a blank page.
From the repo folder run `python3 -m http.server 8000` and open http://localhost:8000/ (it forwards to the hub).

## 106 Steinmann Avenue

`sites/106-steinmann-avenue/` holds every hero style for this listing, built from `listing-heroes/`:
3D build (finished 3D ending in `build/`, real-photo ending in `build-reveal/`), the first-cut build (`build-v1/`),
fly-through, day to dusk, living photo, depth story and photo story. Its `index.html` is the lineup of all eight.
Rebuild with `python3 listing-heroes/heroes/build.py --bundle` and `python3 listing-heroes/v2/build.py <out> --end render|photo`.
