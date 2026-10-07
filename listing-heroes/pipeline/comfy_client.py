#!/usr/bin/env python3
"""Minimal ComfyUI HTTP client (standard library only).

Each workflow in comfyui/workflows/ is ComfyUI API JSON. Its inputs and outputs are listed in
comfyui/workflows/manifest.json as named params: {"image": ["IN image", "image"]} means "set input
`image` on the node titled `IN image`". Image params take a local path; it is uploaded first.

  python3 comfy_client.py --server http://127.0.0.1:8188 depth \
      --param image=listing/photos/front.jpg --out media/ --name front-depth
"""
import argparse, json, mimetypes, os, random, sys, time, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
WF_DIR = os.path.join(HERE, "comfyui", "workflows")


def load_manifest():
    with open(os.path.join(WF_DIR, "manifest.json")) as f:
        return json.load(f)


def _req(server, path, data=None, headers=None, timeout=60):
    req = urllib.request.Request(server.rstrip("/") + path, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def upload_image(server, path, subfolder="listing-heroes"):
    boundary = uuid.uuid4().hex
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        blob = f.read()
    parts = []
    for k, v in (("overwrite", "true"), ("subfolder", subfolder), ("type", "input")):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
                 f"Content-Type: {ctype}\r\n\r\n".encode() + blob + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    out = json.loads(_req(server, "/upload/image", b"".join(parts),
                          {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=300))
    return f"{out['subfolder']}/{out['name']}" if out.get("subfolder") else out["name"]


def find_node(prompt, title):
    for nid, node in prompt.items():
        if node.get("_meta", {}).get("title") == title:
            return nid
    raise KeyError(f"no node titled {title!r} in workflow")


def build_prompt(server, wf_name, params, manifest=None):
    manifest = manifest or load_manifest()
    spec = manifest["workflows"][wf_name]
    with open(os.path.join(WF_DIR, spec["file"])) as f:
        prompt = json.load(f)
    for key, value in params.items():
        if key not in spec["params"]:
            raise KeyError(f"{wf_name}: unknown param {key!r}; known: {', '.join(spec['params'])}")
        targets = spec["params"][key]
        kind = targets[0][2]
        if kind == "image":
            value = upload_image(server, value)
        elif kind == "int":
            value = int(value)
        elif kind == "float":
            value = float(value)
        elif kind == "bool":
            value = str(value).lower() in ("1", "true", "yes")
        for title, field, _ in targets:
            prompt[find_node(prompt, title)]["inputs"][field] = value
    # fresh seeds unless the caller pinned one
    for nid, node in prompt.items():
        for field in ("seed", "noise_seed"):
            if field in node["inputs"] and not isinstance(node["inputs"][field], list) and "seed" not in params:
                node["inputs"][field] = random.randrange(2**48)
    return prompt


def queue(server, prompt):
    body = json.dumps({"prompt": prompt, "client_id": "listing-heroes"}).encode()
    try:
        out = json.loads(_req(server, "/prompt", body, {"Content-Type": "application/json"}))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ComfyUI rejected the workflow: {e.read().decode()[:2000]}") from None
    return out["prompt_id"]


def wait(server, prompt_id, poll=3.0, timeout=3 * 3600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        hist = json.loads(_req(server, f"/history/{prompt_id}"))
        if prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                errs = [m[1] for m in status.get("messages", []) if m[0] == "execution_error"]
                why = "; ".join(f"{e.get('node_type')} ({e.get('node_id')}): {e.get('exception_message', '').strip()}" for e in errs)
                raise RuntimeError(f"ComfyUI job {prompt_id} failed: {why or 'unknown error'}")
            if status.get("completed", True):
                return entry
        time.sleep(poll)
    raise TimeoutError(f"job {prompt_id} still running after {timeout}s")


def outputs(entry, title_by_id=None):
    """Yield (node_id, file dict) for every saved image/video in a finished job."""
    for nid, out in entry.get("outputs", {}).items():
        for key in ("images", "videos", "gifs", "video", "animated"):
            for f in out.get(key, []) or []:
                if isinstance(f, dict) and f.get("filename") and f.get("type") == "output":
                    yield nid, f


def download(server, f, dest):
    q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    with open(dest, "wb") as out:
        out.write(_req(server, f"/view?{q}", timeout=600))
    return dest


def run(server, wf_name, params, out_dir, name):
    """Queue one job, wait, and download every declared output as <name>[-<output>].<ext>."""
    manifest = load_manifest()
    spec = manifest["workflows"][wf_name]
    prompt = build_prompt(server, wf_name, params, manifest)
    entry = wait(server, queue(server, prompt))
    files = list(outputs(entry))
    saved = []
    for label, title in spec["outputs"].items():
        nid = find_node(prompt, title)
        for _, f in [x for x in files if x[0] == nid][:1]:
            ext = os.path.splitext(f["filename"])[1]
            saved.append(download(server, f, os.path.join(out_dir, name + (f"-{label}" if label else "") + ext)))
    if not saved:
        raise RuntimeError(f"{wf_name}: job finished but saved nothing")
    return saved


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workflow")
    ap.add_argument("--server", default=os.environ.get("COMFY_URL", "http://127.0.0.1:8188"))
    ap.add_argument("--param", action="append", default=[], metavar="KEY=VALUE")
    ap.add_argument("--out", default=".")
    ap.add_argument("--name", required=True, help="output file name without extension")
    a = ap.parse_args()
    params = dict(p.split("=", 1) for p in a.param)
    for path in run(a.server, a.workflow, params, a.out, a.name):
        print(path)


if __name__ == "__main__":
    main()
