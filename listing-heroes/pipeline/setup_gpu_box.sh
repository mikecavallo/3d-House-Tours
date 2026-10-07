#!/usr/bin/env bash
# One-shot setup for the listing-heroes GPU pipeline on the 3090 box. Safe to re-run.
# Works from wherever the repo is cloned (e.g. ~/projects/listing-heroes); every path follows the clone.
#   bash pipeline/setup_gpu_box.sh            # set up, start both ComfyUIs, validate
#   bash pipeline/setup_gpu_box.sh --no-start # set up only
set -euo pipefail

COMFY=${COMFY:-/mnt/llm/stable-diffusion/ComfyUI}
MODELS=${MODELS:-/mnt/comfy/comfyui-models}
REPO=$(cd "$(dirname "$0")/.." && pwd)
START=1; [[ "${1:-}" == "--no-start" ]] && START=0
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

[[ -d "$COMFY" ]] || { echo "ComfyUI not found at $COMFY (set COMFY=/path/to/ComfyUI)"; exit 1; }
[[ -d "$MODELS" ]] || { echo "Model folder not found at $MODELS (set MODELS=/path)"; exit 1; }

# the python ComfyUI runs with: its venv if it has one
PY=python3
for v in "$COMFY/venv" "$COMFY/.venv" "$COMFY/../venv"; do [[ -x "$v/bin/python" ]] && PY="$v/bin/python" && break; done
say "ComfyUI: $COMFY  (python: $PY)"

say "Updating ComfyUI"
git -C "$COMFY" pull --ff-only || echo "!! git pull failed (local changes?). Update ComfyUI by hand, then re-run."
"$PY" -m pip install -q -r "$COMFY/requirements.txt"

say "Pointing ComfyUI at $MODELS"
Y="$COMFY/extra_model_paths.yaml"
if [[ -f "$Y" ]] && ! grep -q "listing-heroes" "$Y"; then cp "$Y" "$Y.bak.$(date +%s)"; echo "backed up existing $Y"; fi
cat > "$Y" <<YAML
# written by listing-heroes/pipeline/setup_gpu_box.sh
comfy:
  base_path: $MODELS
  checkpoints: checkpoints
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  loras: loras
  vae: vae
  controlnet: controlnet
  latent_upscale_models: latent_upscale_models
  geometry_estimation: geometry_estimation
  frame_interpolation: frame_interpolation
YAML

say "Downloading the two models you don't have yet"
mkdir -p "$MODELS/geometry_estimation" "$MODELS/frame_interpolation"
get() { [[ -s "$2" ]] && echo "have $(basename "$2")" || wget -q --show-progress -O "$2.part" "$1" && mv "$2.part" "$2" 2>/dev/null || true; }
get https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_mono_large.safetensors \
    "$MODELS/geometry_estimation/depth_anything_3_mono_large.safetensors"
get https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/film_net_fp16.safetensors \
    "$MODELS/frame_interpolation/film_net_fp16.safetensors"

say "Python packages for depth post-processing"
python3 -m pip install -q av numpy opencv-contrib-python-headless

say "n8n workflows for this clone ($REPO)"
mkdir -p "$REPO/pipeline/n8n/local"
LH_REPO="$REPO" LH_OUT="$REPO/pipeline/n8n/local" python3 "$REPO/pipeline/n8n/gen_n8n.py"
echo "Import from pipeline/n8n/local/. Start n8n with:"
echo "  N8N_RESTRICT_FILE_ACCESS_TO=$REPO NODES_EXCLUDE='[]' n8n start"

if [[ $START == 1 ]]; then
  say "Starting one ComfyUI per GPU (logs in $REPO/pipeline/logs)"
  mkdir -p "$REPO/pipeline/logs"
  for i in 0 1; do
    port=$((8188 + i))
    if curl -s -o /dev/null "http://127.0.0.1:$port/system_stats"; then echo "port $port already serving"; continue; fi
    (cd "$COMFY" && CUDA_VISIBLE_DEVICES=$i nohup "$PY" main.py --listen 127.0.0.1 --port $port \
        > "$REPO/pipeline/logs/comfy-gpu$i.log" 2>&1 &)
  done
  for i in 0 1; do
    port=$((8188 + i)); n=0
    until curl -s -o /dev/null "http://127.0.0.1:$port/system_stats"; do
      n=$((n + 1)); [[ $n -gt 120 ]] && { echo "ComfyUI on $port didn't start; see pipeline/logs/comfy-gpu$i.log"; exit 1; }; sleep 2
    done
    echo "GPU$i ready on :$port"
  done
  say "Validating every workflow on both GPUs"
  python3 "$REPO/pipeline/comfyui/validate.py" --server http://127.0.0.1:8188
  python3 "$REPO/pipeline/comfyui/validate.py" --server http://127.0.0.1:8189
  say "Self test"
  python3 "$REPO/pipeline/comfy_client.py" selftest --server http://127.0.0.1:8188 \
      --param image="$REPO/pipeline/comfyui/samples/sample.jpg" --name selftest --out /tmp
  say "Ready. Dry run of the first listing:"
  python3 "$REPO/pipeline/run_listing.py" "$REPO/pipeline/listings/steinmann-106.json" --dry-run | head -5
  echo "Go:  python3 $REPO/pipeline/run_listing.py $REPO/pipeline/listings/steinmann-106.json"
fi
