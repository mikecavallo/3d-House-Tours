# GPU pipeline

Everything that needs the GPUs: depth maps, day-to-dusk, living photos, fly-through transitions, plus
AI room copy with a fair-housing check. Runs on the 2x RTX 3090 box against local ComfyUI. n8n is optional;
the same jobs run from the command line.

```
pipeline/
  comfyui/workflows/   ComfyUI API workflows + manifest.json (generated, don't hand-edit)
  comfyui/templates/   official Comfy-Org templates they're built from
  comfyui/make_workflows.py   rebuilds workflows/ (model filenames live at the top)
  comfyui/validate.py         checks every workflow against your running ComfyUI
  comfy_client.py      run one workflow:  python3 comfy_client.py depth --param image=x.jpg --name x --out out/
  run_listing.py       run a whole listing on both GPUs
  listings/*.json      one file per listing: photos, jobs, prompts, MLS facts, rooms
  tools/depth_from_da3.py     DA3 raw depth -> the disparity PNG the hero pages read
  copy/prompts.json    room-copy and fair-housing prompts + JSON schemas
  n8n/                 importable n8n workflows
```

## One-time setup on the GPU box

1. **Update ComfyUI** (needs the Oct 2026 core nodes: Depth Anything 3, LTX-2.3, frame interpolation).
   `cd /mnt/llm/stable-diffusion/ComfyUI && git pull && pip install -r requirements.txt`
2. **Point ComfyUI at your model folder.** Create `ComfyUI/extra_model_paths.yaml`:
   ```yaml
   comfy:
     base_path: /mnt/comfy/comfyui-models
     checkpoints: checkpoints
     diffusion_models: diffusion_models
     text_encoders: text_encoders
     loras: loras
     vae: vae
     controlnet: controlnet
     latent_upscale_models: latent_upscale_models
     geometry_estimation: geometry_estimation
     frame_interpolation: frame_interpolation
   ```
3. **Download the two models you don't have** (everything else is already in `/mnt/comfy/comfyui-models`):
   ```bash
   cd /mnt/comfy/comfyui-models
   mkdir -p geometry_estimation frame_interpolation
   wget -P geometry_estimation https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_mono_large.safetensors
   wget -P frame_interpolation https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/film_net_fp16.safetensors
   ```
4. **Run one ComfyUI per GPU:**
   ```bash
   cd /mnt/llm/stable-diffusion/ComfyUI
   CUDA_VISIBLE_DEVICES=0 python main.py --listen 127.0.0.1 --port 8188 &
   CUDA_VISIBLE_DEVICES=1 python main.py --listen 127.0.0.1 --port 8189 &
   ```
5. **Check it:**
   ```bash
   pip install av opencv-contrib-python-headless numpy     # for depth post-processing
   python3 pipeline/comfyui/validate.py --server http://127.0.0.1:8188
   python3 pipeline/comfy_client.py selftest --param image=pipeline/comfyui/samples/sample.jpg --name t --out /tmp
   ```
   `validate.py` queues every workflow and cancels it, so ComfyUI checks every node, input and model file
   without rendering anything. All lines should say `ok`.

## Run a listing

```bash
python3 pipeline/run_listing.py pipeline/listings/steinmann-106.json --dry-run   # see the job list
python3 pipeline/run_listing.py pipeline/listings/steinmann-106.json             # go
python3 pipeline/run_listing.py pipeline/listings/steinmann-106.json --only depth,dusk
```

All jobs are queued up front, so both GPUs stay busy: GPU0 takes depth, dusk and the living photo, transitions
alternate between the two. Finished files land in the listing's `out_dir` (`heroes/media/ai/` for Steinmann);
anything already there is skipped unless you pass `--force`.

| Job | Model | Output | Rough time on a 3090 |
|---|---|---|---|
| depth | Depth Anything 3 mono large | `<photo>-depth.png` (drop-in for `heroes/media/`) | seconds |
| dusk | Qwen Image Edit 2509 + Lightning 4-step | `<photo>-dusk.png`, 1664x1040 | under a minute |
| living | Wan 2.2 TI2V 5B | `<photo>-living.mp4`, 5 s at 24 fps, 1280x800 | several minutes |
| transition | LTX-2.3 22B dev fp8 + distilled LoRA | `<from>-to-<to>.mp4`, 4 s at 25 fps, 1280x800, plus a FILM-doubled `-50fps.mp4` | several minutes each |

Using the outputs: copy a `-depth.png` you like over the hand-built one in `heroes/media/` and rebuild with
`python3 heroes/build.py`. Transitions and the dusk photo are source footage for the next round of the hero pages
(scroll-scrubbed video between photos, a real twilight end frame); they aren't wired into the pages yet.

## Prompts and settings

Per-listing prompts live in `listings/<id>.json` (transition camera moves, living-photo motion, dusk wording).
Workflow defaults, model filenames and node settings live in `comfyui/make_workflows.py`; edit there and run
`python3 pipeline/comfyui/make_workflows.py`. Settings worth knowing:

- transitions: `seconds` (default 4), `strength` (how hard the first and last frames are held, default 0.9),
  `seed` per transition in the listing file. Re-roll a bad one by deleting its mp4 and re-running.
- living: keep the camera locked in the prompt; Wan likes to drift. 121 frames is the 5B model's sweet spot.
- dusk: the edit must keep the house identical. The page discloses it as a simulated twilight view.

## Licensing (client work)

- OK commercially: Qwen Image Edit 2509 and its Lightning LoRA (Apache 2.0), Wan 2.2 (Apache 2.0),
  FILM interpolation (Apache 2.0).
- Check before selling: LTX-2.3 (LTX-2 Community License: free under a revenue threshold, read the current terms),
  Depth Anything 3 mono large (check the model card's license; if it's non-commercial, swap to the hand-built depth
  maps or `depth_anything_3_base` and re-run `validate.py`).
- Don't use for client deliverables: Flux dev / Flux Fill dev (non-commercial).

## n8n

See `n8n/README.md`.
