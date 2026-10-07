#!/usr/bin/env python3
"""Check every workflow against a running ComfyUI: node types exist, inputs are valid, model files are present.

  python3 comfyui/validate.py --server http://127.0.0.1:8188

It queues each workflow with sample inputs and cancels it right away, so nothing renders. ComfyUI rejects an
invalid workflow at queue time and lists every bad node, so a clean pass means the GPU run will start.
"""
import argparse, json, os, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import comfy_client as cc

SAMPLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default=os.environ.get("COMFY_URL", "http://127.0.0.1:8188"))
    a = ap.parse_args()
    stats = json.loads(cc._req(a.server, "/system_stats"))
    print("ComfyUI", stats.get("system", {}).get("comfyui_version", "?"), "|",
          ", ".join(d.get("name", "?") for d in stats.get("devices", [])))
    img, vid = os.path.join(SAMPLES, "sample.jpg"), os.path.join(SAMPLES, "sample.mp4")
    manifest = cc.load_manifest()
    bad = 0
    for name, spec in manifest["workflows"].items():
        params = {k: (vid if k == "video" else img) for k, t in spec["params"].items() if t[0][2] == "image"}
        try:
            prompt = cc.build_prompt(a.server, name, params, manifest)
            pid = cc.queue(a.server, prompt)
            body = json.dumps({"delete": [pid]}).encode()
            cc._req(a.server, "/queue", body, {"Content-Type": "application/json"})
            cc._req(a.server, "/interrupt", b"{}", {"Content-Type": "application/json"})
            print(f"  ok    {name}")
        except Exception as e:
            bad += 1
            msg = str(e)
            print(f"  FAIL  {name}: {msg[:1500]}")
            if "not in" in msg and spec.get("download_first"):
                print(f"        missing model? needs models/{spec['download_first']}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
