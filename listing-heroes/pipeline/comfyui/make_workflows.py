#!/usr/bin/env python3
"""Build the listing-heroes ComfyUI workflows from the official ComfyUI templates.

templates/*.api.json are the official Comfy-Org templates (comfyui-workflow-templates 0.11.76),
converted to API format by ComfyUI's own frontend. This script swaps in the model files on the
GPU box, names the nodes the pipeline drives ("IN ...", "OUT"), and writes workflows/ + manifest.
Re-run it after editing; never hand-edit workflows/.
"""
import copy, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
T = lambda n: json.load(open(os.path.join(HERE, "templates", n + ".api.json")))
WF = os.path.join(HERE, "workflows")

# ---- model files on the GPU box (/mnt/comfy/comfyui-models) ----
LTX_CKPT = "ltx-2.3-22b-dev-fp8.safetensors"
LTX_DISTILL_LORA = "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors"
GEMMA = "gemma_3_12B_it_fp4_mixed.safetensors"
QWEN_EDIT = "qwen_image_edit_2509_fp8_e4m3fn.safetensors"
QWEN_LIGHTNING = "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"
WAN5B = "wan2.2_ti2v_5B_fp16.safetensors"
DA3 = "depth_anything_3_mono_large.safetensors"        # download: see README
FILM = "film_net_fp16.safetensors"                     # download: see README

NEG_VIDEO = ("blurry, out of focus, low quality, flicker, warping, morphing walls, melting furniture, "
             "distorted architecture, bent lines, extra doors, extra windows, text, watermark, logo, people, "
             "person, animals, camera shake, jump cut, cartoon, CGI look")


def title(wf, nid, t):
    wf[nid].setdefault("_meta", {})["title"] = t


def by_class(wf, cls):
    return [k for k, v in wf.items() if v["class_type"] == cls]


def new_id(wf, base):
    i = base
    while str(i) in wf:
        i += 1
    return str(i)


def rewire(wf, old, new):
    for v in wf.values():
        for k, x in v["inputs"].items():
            if isinstance(x, list) and len(x) == 2 and x == old:
                v["inputs"][k] = new


# ---------------------------------------------------------------- depth (Depth Anything 3)
def depth():
    """Raw DA3 depth as a 32-bit float EXR plus the sky mask. tools/depth_from_da3.py turns them into the
    disparity PNG depthcam.js reads. (DA3Render's own 8-bit modes are linear in depth, not disparity, so they
    squash everything past the first room into a flat gray.)"""
    wf = T("utility_depth_anything3_image_depth_estimation")
    for k in by_class(wf, "PreviewImage") + by_class(wf, "ImageCompare"):
        del wf[k]
    load, = by_class(wf, "LoadImage"); title(wf, load, "IN image")
    inf, = by_class(wf, "DA3Inference"); wf[inf]["inputs"]["resolution"] = 1008   # finer edges than the 504 default
    title(wf, inf, "IN resolution")
    ren, = by_class(wf, "DA3Render")
    wf[ren]["inputs"] = {"da3_geometry": wf[ren]["inputs"]["da3_geometry"], "output": "depth",
                         "output.normalization": "raw", "output.apply_sky_clip": False}
    sky = new_id(wf, 20)
    wf[sky] = {"class_type": "DA3Render", "inputs": {"da3_geometry": wf[ren]["inputs"]["da3_geometry"], "output": "sky_mask"}}
    sid = new_id(wf, 90)
    wf[sid] = {"class_type": "SaveImageAdvanced", "inputs": {"images": [ren, 0], "filename_prefix": "listing-heroes/depth",
                                                             "format": "exr", "format.bit_depth": "32-bit float",
                                                             "format.input_color_space": "linear"}}
    title(wf, sid, "OUT")
    kid = new_id(wf, 95)
    wf[kid] = {"class_type": "SaveImage", "inputs": {"images": [sky, 0], "filename_prefix": "listing-heroes/sky"}}
    title(wf, kid, "OUT sky")
    wf[by_class(wf, "LoadDA3Model")[0]]["inputs"]["model_name"] = DA3
    return wf, {"image": [["IN image", "image", "image"]], "resolution": [["IN resolution", "resolution", "int"]],
                "prefix": [["OUT", "filename_prefix", "str"]]}, {"depth": "OUT", "sky": "OUT sky"}


# ---------------------------------------------------------------- dusk (Qwen Image Edit 2509 + Lightning)
DUSK_PROMPT = ("Change the time of day to dusk, about twenty minutes after sunset: a clear deep-blue twilight sky "
               "with a soft warm glow near the horizon. Turn on every interior light so the windows glow warm "
               "yellow, turn on the porch lamp, and light the house softly as in a professional twilight real "
               "estate photo. Keep the house, roof, siding, windows, doors, deck, landscaping, lawn, trees, camera "
               "angle and composition exactly the same. Do not add or remove anything.")


def dusk():
    wf = T("image_qwen_image_edit_2509")
    load, = by_class(wf, "LoadImage"); title(wf, load, "IN image")
    enc = by_class(wf, "TextEncodeQwenImageEditPlus")
    pos = [k for k in enc if wf[k]["inputs"]["prompt"]][0]
    wf[pos]["inputs"]["prompt"] = DUSK_PROMPT; title(wf, pos, "IN prompt")
    # bigger than the template's ~1 MP FluxKontextImageScale so twilight detail survives on a 2048 px hero
    fk, = by_class(wf, "FluxKontextImageScale")
    wf[fk] = {"class_type": "ImageScale", "inputs": {"image": wf[fk]["inputs"]["image"], "upscale_method": "lanczos",
                                                     "width": 1664, "height": 1040, "crop": "center"}}
    title(wf, fk, "IN size")
    save, = by_class(wf, "SaveImageAdvanced"); title(wf, save, "OUT")
    wf[save]["inputs"]["filename_prefix"] = "listing-heroes/dusk"
    wf[by_class(wf, "UNETLoader")[0]]["inputs"]["unet_name"] = QWEN_EDIT
    wf[by_class(wf, "LoraLoaderModelOnly")[0]]["inputs"]["lora_name"] = QWEN_LIGHTNING
    ks, = by_class(wf, "KSampler"); title(wf, ks, "IN sampler")
    return wf, {"image": [["IN image", "image", "image"]], "prompt": [["IN prompt", "prompt", "str"]],
                "width": [["IN size", "width", "int"]], "height": [["IN size", "height", "int"]],
                "seed": [["IN sampler", "seed", "int"]], "prefix": [["OUT", "filename_prefix", "str"]]}


# ---------------------------------------------------------------- transition (LTX-2.3 first/last frame)
def transition():
    wf = T("video_ltx2_3_flf2v")
    first = [k for k in by_class(wf, "LoadImage") if wf[k]["_meta"]["title"] == "Load First Frame"][0]
    last = [k for k in by_class(wf, "LoadImage") if wf[k]["_meta"]["title"] == "Load Last Frame"][0]
    title(wf, first, "IN first frame"); title(wf, last, "IN last frame")
    texts = by_class(wf, "CLIPTextEncode")
    neg = [k for k in texts if wf[k]["inputs"]["text"].startswith("blurry")][0]
    pos = [k for k in texts if k != neg][0]
    wf[neg]["inputs"]["text"] = NEG_VIDEO; title(wf, neg, "IN negative")
    wf[pos]["inputs"]["text"] = "Smooth, steady drone shot gliding forward through the house."; title(wf, pos, "IN prompt")
    prim = {wf[k]["_meta"]["title"]: k for k in by_class(wf, "PrimitiveInt")}
    wf[prim["Width"]]["inputs"]["value"] = 1280; title(wf, prim["Width"], "IN width")
    wf[prim["height"]]["inputs"]["value"] = 800; title(wf, prim["height"], "IN height")      # 16:10, like the listing photos
    wf[prim["Duration"]]["inputs"]["value"] = 4; title(wf, prim["Duration"], "IN seconds")
    guides = by_class(wf, "LTXVAddGuide")
    for g in guides:
        wf[g]["inputs"]["strength"] = 0.9      # land on the real photos; the template's 0.7 drifts off the last frame
        title(wf, g, "IN guide first" if wf[g]["inputs"]["frame_idx"] == 0 else "IN guide last")
    # the box has the dev checkpoint + the distilled LoRA (= the template's distilled checkpoint)
    ck, = by_class(wf, "CheckpointLoaderSimple")
    wf[ck]["inputs"]["ckpt_name"] = LTX_CKPT
    for k in by_class(wf, "LTXVAudioVAELoader") + by_class(wf, "LTXAVTextEncoderLoader"):
        wf[k]["inputs"]["ckpt_name"] = LTX_CKPT
    for k in by_class(wf, "LTXAVTextEncoderLoader"):
        wf[k]["inputs"]["text_encoder"] = GEMMA
    lid = new_id(wf, 200)
    rewire(wf, [ck, 0], [lid, 0])
    wf[lid] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": [ck, 0], "lora_name": LTX_DISTILL_LORA, "strength_model": 1.0}}
    title(wf, lid, "Distilled LoRA")
    noise, = by_class(wf, "RandomNoise"); title(wf, noise, "IN noise")
    save, = by_class(wf, "SaveVideo"); title(wf, save, "OUT")
    wf[save]["inputs"]["filename_prefix"] = "listing-heroes/transition"
    return wf, {"first": [["IN first frame", "image", "image"]], "last": [["IN last frame", "image", "image"]],
                "prompt": [["IN prompt", "text", "str"]], "negative": [["IN negative", "text", "str"]],
                "width": [["IN width", "value", "int"]], "height": [["IN height", "value", "int"]],
                "seconds": [["IN seconds", "value", "int"]],
                "strength": [["IN guide first", "strength", "float"], ["IN guide last", "strength", "float"]],
                "seed": [["IN noise", "noise_seed", "int"]], "prefix": [["OUT", "filename_prefix", "str"]]}


# ---------------------------------------------------------------- living photo (Wan 2.2 TI2V 5B, image to video)
LIVING_PROMPT = ("Locked-off tripod shot, the camera does not move. A gentle summer breeze: white clouds drift slowly "
                 "across the sky, tree leaves and flowers sway softly, fabric curtains ripple. The house, deck, "
                 "furniture and lawn stay perfectly still. No people, no animals, no new objects.")


def living():
    wf = T("video_wan2_2_5B_ti2v")
    lid = new_id(wf, 56)
    wf[lid] = {"class_type": "LoadImage", "inputs": {"image": "example.png"}}
    title(wf, lid, "IN image")
    lat, = by_class(wf, "Wan22ImageToVideoLatent")
    wf[lat]["inputs"].update({"start_image": [lid, 0], "width": 1280, "height": 800, "length": 121})
    title(wf, lat, "IN size")
    pos = [k for k in by_class(wf, "CLIPTextEncode") if "Positive" in wf[k]["_meta"]["title"]][0]
    neg = [k for k in by_class(wf, "CLIPTextEncode") if "Negative" in wf[k]["_meta"]["title"]][0]
    wf[pos]["inputs"]["text"] = LIVING_PROMPT; title(wf, pos, "IN prompt")
    wf[neg]["inputs"]["text"] = NEG_VIDEO + ", camera movement, zoom, pan"; title(wf, neg, "IN negative")
    wf[by_class(wf, "UNETLoader")[0]]["inputs"]["unet_name"] = WAN5B
    ks, = by_class(wf, "KSampler"); title(wf, ks, "IN sampler")
    save, = by_class(wf, "SaveVideo"); title(wf, save, "OUT")
    wf[save]["inputs"]["filename_prefix"] = "listing-heroes/living"
    return wf, {"image": [["IN image", "image", "image"]], "prompt": [["IN prompt", "text", "str"]],
                "negative": [["IN negative", "text", "str"]],
                "width": [["IN size", "width", "int"]], "height": [["IN size", "height", "int"]],
                "frames": [["IN size", "length", "int"]], "steps": [["IN sampler", "steps", "int"]],
                "seed": [["IN sampler", "seed", "int"]], "prefix": [["OUT", "filename_prefix", "str"]]}


# ---------------------------------------------------------------- frame interpolation (FILM, doubles fps)
def interpolate():
    wf = T("utility_video_frame_interpolation")
    lv, = by_class(wf, "LoadVideo"); title(wf, lv, "IN video")
    mult = [k for k in by_class(wf, "PrimitiveInt")][0]; title(wf, mult, "IN multiplier")
    wf[by_class(wf, "FrameInterpolationModelLoader")[0]]["inputs"]["model_name"] = FILM
    save, = by_class(wf, "SaveVideo"); title(wf, save, "OUT")
    wf[save]["inputs"]["filename_prefix"] = "listing-heroes/interp"
    return wf, {"video": [["IN video", "file", "image"]], "multiplier": [["IN multiplier", "value", "int"]],
                "prefix": [["OUT", "filename_prefix", "str"]]}


# ---------------------------------------------------------------- self test (no models, runs on CPU in seconds)
def selftest():
    wf = {"1": {"class_type": "LoadImage", "inputs": {"image": "example.png"}, "_meta": {"title": "IN image"}},
          "2": {"class_type": "ImageScale", "inputs": {"image": ["1", 0], "upscale_method": "area", "width": 320,
                                                        "height": 200, "crop": "center"}},
          "3": {"class_type": "ImageInvert", "inputs": {"image": ["2", 0]}},
          "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "listing-heroes/selftest"},
                "_meta": {"title": "OUT"}}}
    return wf, {"image": [["IN image", "image", "image"]]}


BUILDERS = {
    "selftest": (selftest, "Plumbing check: upload, queue, wait, download (no models needed)", None),
    "depth": (depth, "Depth Anything 3 raw depth (float EXR) + sky mask; depth_from_da3.py makes the depthcam.js disparity PNG", "geometry_estimation/" + DA3),
    "dusk": (dusk, "Day-to-dusk photo edit (Qwen Image Edit 2509, 4-step Lightning)", None),
    "transition": (transition, "First/last-frame camera move between two photos (LTX-2.3 22B dev + distilled LoRA)", None),
    "living": (living, "Living photo: subtle motion from one still (Wan 2.2 TI2V 5B)", None),
    "interpolate": (interpolate, "Double a video's frame rate (FILM) for smooth scroll scrubbing", "frame_interpolation/" + FILM),
}

if __name__ == "__main__":
    os.makedirs(WF, exist_ok=True)
    manifest = {"note": "Generated by make_workflows.py. params: name -> list of [node title, input, type].", "workflows": {}}
    for name, (fn, desc, needs) in BUILDERS.items():
        res = fn()
        wf, params = res[0], res[1]
        outs = res[2] if len(res) > 2 else {"": "OUT"}
        titles = [v.get("_meta", {}).get("title") for v in wf.values()]
        for targets in params.values():
            for t, _, _ in targets:
                assert titles.count(t) == 1, (name, t, titles.count(t))
        with open(os.path.join(WF, name + ".api.json"), "w") as f:
            json.dump(wf, f, indent=2)
        manifest["workflows"][name] = {"file": name + ".api.json", "description": desc, "params": params, "outputs": outs,
                                       **({"download_first": needs} if needs else {})}
        print(f"{name}: {len(wf)} nodes, params {', '.join(params)}")
    with open(os.path.join(WF, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
