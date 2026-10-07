# n8n workflows

Three importable workflows. All of them read and write files in this repo, so run n8n on the GPU box itself
(not in Docker, unless you mount the repo at the same path and give the container Python).

| File | What it does |
|---|---|
| `listing-heroes-comfyui-job.json` | Sub-workflow. Uploads photos to ComfyUI, fills a workflow from `pipeline/comfyui/workflows`, queues it (submit), or polls and downloads the results (collect). Plain HTTP to ComfyUI. |
| `listing-heroes-gpu-pipeline.json` | Reads `pipeline/listings/<id>.json`, queues every job on both GPUs at once, waits for all of them, converts depth to disparity PNGs, then makes 50 fps copies of the transitions. |
| `listing-heroes-room-copy.json` | Sends the room photos + MLS facts to Claude for room-by-room copy, runs a second Claude pass as a fair-housing and accuracy review, writes `<out_dir>/rooms.json`. |

## Setup (once)

1. n8n 2.x needs **Node 24**. Install and start it with the two settings these workflows need:
   ```bash
   npm install -g n8n
   export N8N_RESTRICT_FILE_ACCESS_TO=~/projects/listing-heroes  # where you cloned this repo
   export NODES_EXCLUDE="[]"                                     # re-enables Execute Command (off by default in n8n 2.x)
   n8n start
   ```
   Without the first, n8n can't read the photos or save outputs. Without the second, the "Make output folders"
   and "Depth to disparity" steps are refused.
2. Import the three files from `pipeline/n8n/local/` (Workflows > Import from file), or from the shell:
   ```bash
   for f in pipeline/n8n/local/listing-heroes-*.json; do n8n import:workflow --input=$f; done
   ```
   `setup_gpu_box.sh` writes that folder with your clone's path already filled in. Without it, run
   `LH_REPO=$PWD LH_OUT=pipeline/n8n/local python3 pipeline/n8n/gen_n8n.py` from the repo root.
3. **Publish** "listing-heroes · ComfyUI job". The pipeline calls it as a sub-workflow, and n8n only runs
   published sub-workflows.
4. If you move the clone later, re-run the generator above and re-import (or edit `repo` in each **Config** node).
5. Room copy only: create a credential of type **Header Auth** named `Anthropic API key`, with name `x-api-key`
   and your API key as the value, and pick it in the two "(Claude)" nodes.

## Run

- Manually: open the workflow, Execute. Config defaults to `steinmann-106`.
- From anywhere: publish the workflow, then
  `curl -X POST http://<box>:5678/webhook/listing-heroes-gpu -H 'content-type: application/json' -d '{"listing":"steinmann-106"}'`
  (room copy: `/webhook/listing-heroes-copy`).

The GPU pipeline doesn't block n8n while it waits: ComfyUI holds the queue, n8n checks `/history` every 10 seconds.
A job that fails stops the run with the node and reason, for example `living: LoadDA3Model (14:82): ...`; jobs
that already finished keep their files. Re-running skips nothing in n8n (the CLI runner `run_listing.py` skips
existing outputs), so delete what you want redone or use the CLI.

## Room copy details

- Model `claude-opus-5-5`, structured output (JSON schema in `pipeline/copy/prompts.json`), server-side fallback
  on (`fallbacks: "default"`), draft at effort `medium`, review at `high`.
- One request carries all room photos (about 7 MB for 12 rooms at 2048 px). Keep listings under ~40 rooms.
- `rooms.json` records what the review changed (`issues_fixed`). Read it before publishing: the check catches
  common fair-housing language, it is not legal review.

## Editing

The JSON files are generated. Change `src/*.js` (the Code-node scripts) or `gen_n8n.py`, then
`python3 pipeline/n8n/gen_n8n.py` and re-import.

## Tested

Imported and executed in n8n 2.41.7 (Node 24) against a CPU ComfyUI 0.38: two jobs queued across two servers,
collected and downloaded; a failing job stopped the run with a readable error; room copy ran against a mock of
the Messages API that checked headers, model, fallback, schema and all 12 images, and wrote `rooms.json` with the
flagged phrase rewritten. Not tested here: real GPU renders (no GPU in the build container) and a live Claude call.
