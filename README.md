# 3D House Tours

Five property sites and the Five Houses hub that links them, plus the tour data and the listing-hero pipeline behind them.

| Folder | What it is |
|---|---|
| `sites/` | The hub (`sites/index.html`) and one static site per house: Sun-Drenched Production Space, Vine Leaf Residence, 47 Ross Avenue, The Mission House, The Noe Valley Victorian |
| `tours/` | Per-house tour data: 360° panoramas, layout, tour-data.json, floor plans, thumbnails, source image lists |
| `listing-heroes/` | The listing-hero pipeline, story pages and hero images (copy of `mikecavallo/listing-heroes`) |

Serve the repo root with any static host and open `/sites/`. Each house's raw 360° panoramas are in `tours/<house>/pano/`.
