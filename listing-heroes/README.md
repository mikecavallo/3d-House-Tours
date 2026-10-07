# listing-heroes

Interactive hero pages for real estate listings. First listing: 106 Steinmann Avenue, Middlebury, CT.

| Style | Where |
|---|---|
| Fly-through, day to dusk, living photo, depth story | `heroes/` (shared WebGL depth camera in `heroes/shared/depthcam.js`) |
| 3D build | `v2/` |
| Photo story | `story/` |

Build the hero pages: `python3 heroes/build.py [--bundle --artifact] [page ...]` (output in `heroes/dist/`).
Depth maps: author a spec in `heroes/tools/specs/`, build with `heroes/tools/depth.py`, check with `heroes/tools/move.py`. See `heroes/tools/DEPTH_GUIDE.md`.
Raw listing photos (watermarked MLS copies) live in `listing/`. Use the photographer's originals for client work.

## GPU pipeline and automation

`pipeline/` holds the ComfyUI workflows (depth, day to dusk, living photo, fly-through transitions), a two-GPU
runner, and n8n workflows including AI room copy with a fair-housing review. Start with `pipeline/README.md`.
