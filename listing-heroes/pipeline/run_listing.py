#!/usr/bin/env python3
"""Run every GPU job for one listing on the local ComfyUI servers, then post-process.

  python3 run_listing.py listings/steinmann-106.json [--only depth,dusk] [--dry-run]

Jobs are queued on both servers up front (ComfyUI keeps its own queue), so both GPUs stay busy:
gpu0 takes depth maps, dusk edits and the living photo; transitions alternate across both GPUs.
Outputs land in out_dir: <photo>-depth.png (disparity, ready for heroes/), <photo>-dusk.png,
<photo>-living.mp4, <from>-to-<to>.mp4 (+ <from>-to-<to>-50fps.mp4 when interpolate_transitions is on). Existing outputs are skipped unless --force.
"""
import argparse, concurrent.futures as cf, json, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import comfy_client as cc


def plan(L):
    """Expand a listing file into (kind, server_key, name, workflow, params) jobs."""
    pdir = L["_photos"]
    photo = lambda n: os.path.join(pdir, n + ".jpg")
    jobs = []
    for n in L.get("depth", []):
        jobs.append(("depth", "gpu0", n, "depth", {"image": photo(n)}))
    for d in L.get("dusk", []):
        p = {"image": photo(d["photo"])}
        if d.get("prompt"):
            p["prompt"] = d["prompt"]
        jobs.append(("dusk", "gpu0", d["photo"] + "-dusk", "dusk", p))
    for v in L.get("living", []):
        p = {"image": photo(v["photo"])}
        if v.get("prompt"):
            p["prompt"] = v["prompt"]
        jobs.append(("living", "gpu0", v["photo"] + "-living", "living", p))
    for i, t in enumerate(L.get("transitions", [])):
        p = {"first": photo(t["from"]), "last": photo(t["to"]), "prompt": t["prompt"]}
        for k in ("seconds", "strength", "seed"):
            if k in t:
                p[k] = t[k]
        jobs.append(("transition", "gpu1" if i % 2 == 0 else "gpu0", f"{t['from']}-to-{t['to']}", "transition", p))
    # custom jobs: {"workflow": "selftest", "name": "front-test", "images": {"image": "front"}, "params": {...}, "gpu": "gpu1"}
    for c in L.get("jobs", []):
        p = dict(c.get("params", {}))
        p.update({k: photo(n) for k, n in c.get("images", {}).items()})
        jobs.append(("custom", c.get("gpu", "gpu0"), c["name"], c["workflow"], p))
    return jobs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("listing")
    ap.add_argument("--only", help="comma list of kinds: depth,dusk,living,transition")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mkdir-only", action="store_true", help="just create out_dir (used by n8n, whose file writer can't)")
    ap.add_argument("--post-only", action="store_true",
                    help="only convert downloaded raw depth (out_dir/raw/*-depth.exr) into disparity PNGs (used by n8n)")
    a = ap.parse_args()
    base = os.path.dirname(os.path.abspath(a.listing))
    L = json.load(open(a.listing))
    L["_photos"] = os.path.normpath(os.path.join(base, L["photos_dir"]))
    out = os.path.normpath(os.path.join(base, L["out_dir"]))
    servers = L.get("servers") or {"gpu0": "http://127.0.0.1:8188"}
    servers.setdefault("gpu1", servers["gpu0"])
    only = set(a.only.split(",")) if a.only else None
    raw = os.path.join(out, "raw")
    os.makedirs(raw, exist_ok=True)
    if a.mkdir_only:
        print(out)
        return

    if a.post_only:
        for j in plan(L):
            exr = os.path.join(raw, j[2] + "-depth.exr")
            if j[0] == "depth" and os.path.exists(exr):
                sky = os.path.join(raw, j[2] + "-sky.png")
                dest = os.path.join(out, j[2] + "-depth.png")
                subprocess.run([sys.executable, os.path.join(HERE, "tools", "depth_from_da3.py"), exr,
                                sky if os.path.exists(sky) else "", dest, "--like", j[4]["image"]], check=True)
        return

    jobs = [j for j in plan(L) if not only or j[0] in only]
    ext = {"depth": "-depth.png", "dusk": ".png", "custom": ".png"}
    final = lambda j: os.path.join(out, j[2] + ext.get(j[0], ".mp4"))
    todo = [j for j in jobs if a.force or not os.path.exists(final(j))]
    print(f"{len(jobs)} jobs, {len(todo)} to run")
    for j in todo:
        print(f"  {j[0]:10} {j[1]}  {j[2]}")
    if a.dry_run or not todo:
        return

    manifest = cc.load_manifest()
    # queue everything first so each ComfyUI works through its own queue
    queued = []
    for j in todo:
        kind, sk, name, wf, params = j
        prompt = cc.build_prompt(servers[sk], wf, params, manifest)
        queued.append((j, prompt, cc.queue(servers[sk], prompt)))
        print(f"queued {name} on {sk}")

    def finish(item):
        (kind, sk, name, wf, params), prompt, pid = item
        server = servers[sk]
        entry = cc.wait(server, pid)
        files = list(cc.outputs(entry))
        got = {}
        for label, title in manifest["workflows"][wf]["outputs"].items():
            nid = cc.find_node(prompt, title)
            for _, f in [x for x in files if x[0] == nid][:1]:
                ext = os.path.splitext(f["filename"])[1]
                dest = os.path.join(raw if kind == "depth" else out, name + (f"-{label}" if label else "") + ext)
                got[label] = cc.download(server, f, dest)
        if kind == "depth":
            subprocess.run([sys.executable, os.path.join(HERE, "tools", "depth_from_da3.py"), got["depth"], got.get("sky", ""),
                            final(item[0]), "--like", params["image"]], check=True)
        if kind == "transition" and L.get("interpolate_transitions"):
            cc.run(server, "interpolate", {"video": got[""]}, out, name + "-50fps")
        return name

    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for fut in cf.as_completed([ex.submit(finish, q) for q in queued]):
            try:
                print(f"done {fut.result()}  ({time.time() - t0:.0f}s)")
            except Exception as e:
                print(f"FAILED: {e}")


if __name__ == "__main__":
    main()
