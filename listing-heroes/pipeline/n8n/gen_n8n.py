#!/usr/bin/env python3
"""Generate the importable n8n workflows from src/*.js. Edit the JS or this file, then re-run.

Writes:
  listing-heroes-comfyui-job.json   sub-workflow: upload, queue, poll, download (pure HTTP to ComfyUI)
  listing-heroes-gpu-pipeline.json  main: listing file -> all GPU jobs on both GPUs -> depth post-processing
  listing-heroes-room-copy.json     room-by-room copy from the photos + fair-housing review (Claude API)
"""
import json, os, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
JS = lambda n: open(os.path.join(HERE, "src", n)).read()
REPO = os.environ.get("LH_REPO", "/mnt/llm/listing-heroes")   # where the repo is cloned on the GPU box; change in the Config node
DEFAULT_LISTING = os.environ.get("LH_LISTING", "steinmann-106")
OUT_DIR = os.environ.get("LH_OUT", HERE)
CLAUDE_URL = os.environ.get("LH_CLAUDE_URL", "https://api.anthropic.com/v1/messages")   # test hook only
SUB_ID = "lhComfyJob000001"


def node(name, type_, version, params, pos, **extra):
    n = {"parameters": params, "name": name, "type": type_, "typeVersion": version, "position": pos,
         "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "listing-heroes/" + name))}
    n.update(extra)
    return n


def code(name, js, pos, each=False, **extra):
    p = {"jsCode": js}
    if each:
        p["mode"] = "runOnceForEachItem"
    return node(name, "n8n-nodes-base.code", 2, p, pos, **extra)


def http(name, pos, method, url, body=None, multipart=None, file_response=False, headers=None, cred=None, timeout=120000, **extra):
    p = {"method": method, "url": url, "options": {"timeout": timeout}}
    if headers:
        p["sendHeaders"] = True
        p["headerParameters"] = {"parameters": [{"name": k, "value": v} for k, v in headers.items()]}
    if body is not None:
        p.update({"sendBody": True, "specifyBody": "json", "jsonBody": body})
    if multipart is not None:
        p.update({"sendBody": True, "contentType": "multipart-form-data", "bodyParameters": {"parameters": multipart}})
    if file_response:
        p["options"]["response"] = {"response": {"responseFormat": "file"}}
    if cred:
        p.update({"authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth"})
        extra["credentials"] = {"httpHeaderAuth": {"id": "lhAnthropicKey01", "name": cred}}
    return node(name, "n8n-nodes-base.httpRequest", 4.2, p, pos, **extra)


def read_file(name, selector, pos, **extra):
    return node(name, "n8n-nodes-base.readWriteFile", 1, {"fileSelector": selector, "options": {}}, pos, **extra)


def write_file(name, file_name, pos, **extra):
    return node(name, "n8n-nodes-base.readWriteFile", 1, {"operation": "write", "fileName": file_name,
                                                          "dataPropertyName": "data", "options": {}}, pos, **extra)


def cond(field, op, value=None, kind="string"):
    c = {"id": str(uuid.uuid4()), "leftValue": f"={{{{ {field} }}}}", "operator": {"type": kind, "operation": op}}
    if value is not None:
        c["rightValue"] = value
    if op in ("true", "false", "empty", "notEmpty", "exists"):
        c["operator"]["singleValue"] = True
    return c


def conds(*cs):
    return {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
            "conditions": list(cs), "combinator": "and"}


def connect(pairs):
    conns = {}
    for src, dst, *rest in pairs:
        out = rest[0] if rest else 0
        c = conns.setdefault(src, {"main": []})["main"]
        while len(c) <= out:
            c.append([])
        c[out].append({"node": dst, "type": "main", "index": 0})
    return conns


def workflow(name, nodes, pairs, wid, notes=None):
    wf = {"name": name, "nodes": nodes, "connections": connect(pairs), "active": False,
          "settings": {"executionOrder": "v1", "callerPolicy": "workflowsFromSameOwner"},
          "id": wid, "meta": {"templateCredsSetupCompleted": True}, "pinData": {}, "tags": []}
    if notes:
        wf["nodes"].append(node("README", "n8n-nodes-base.stickyNote", 1, {"content": notes, "height": 420, "width": 520}, [-520, -260]))
    return wf


# ------------------------------------------------------------------ sub-workflow: one or more ComfyUI jobs
sub_nodes = [
    node("When called", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, [0, 300]),
    code("Job", "return { json: $json };", [220, 300], each=True),
    node("Collect mode?", "n8n-nodes-base.if", 2.2, {"conditions": conds(cond("$json.mode", "equals", "collect")), "options": {}}, [440, 300]),
    # submit
    read_file("Read workflow files", "={{ $('Job').first().json.repo }}/pipeline/comfyui/workflows/*.json", [660, 460], executeOnce=True),
    code("Parse workflow files", JS("parse_files.js"), [880, 460]),
    code("List uploads", JS("list_uploads.js"), [1100, 460]),
    read_file("Read input file", "={{ $json.path }}", [1320, 460]),
    http("Upload to ComfyUI", [1540, 460], "POST", "={{ $('List uploads').item.json.server }}/upload/image",
         multipart=[{"parameterType": "formBinaryData", "name": "image", "inputDataFieldName": "data"},
                    {"name": "overwrite", "value": "true"}, {"name": "subfolder", "value": "listing-heroes"}]),
    code("Collect uploads", JS("collect_uploads.js"), [1760, 460]),
    code("Build prompt", JS("build_prompt.js"), [1980, 460], each=True),
    http("Queue job", [2200, 460], "POST", "={{ $json.server }}/prompt", body="={{ JSON.stringify($json.prompt_body) }}"),
    code("Submitted", "const j = Object.assign({}, $('Build prompt').item.json);\ndelete j.prompt_body; delete j.uploads;\nreturn { json: Object.assign(j, { prompt_id: $json.prompt_id, mode: 'collect' }) };", [2420, 460], each=True),
    # collect
    node("Wait for job", "n8n-nodes-base.wait", 1.1, {"amount": 10}, [660, 140], webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "lh-wait"))),
    http("Get history", [880, 140], "GET", "={{ $json.server }}/history/{{ $json.prompt_id }}"),
    code("Check job", JS("check_history.js"), [1100, 140], each=True),
    node("Route", "n8n-nodes-base.switch", 3.2, {"rules": {"values": [
        {"conditions": conds(cond("$json.state", "equals", "pending")), "renameOutput": True, "outputKey": "pending"},
        {"conditions": conds(cond("$json.state", "equals", "error")), "renameOutput": True, "outputKey": "error"},
        {"conditions": conds(cond("$json.state", "equals", "done")), "renameOutput": True, "outputKey": "done"}]}, "options": {}}, [1320, 140]),
    node("Job failed", "n8n-nodes-base.stopAndError", 1, {"errorMessage": "={{ $json.name }}: {{ $json.error }}"}, [1540, 140]),
    code("Expand downloads", JS("expand_downloads.js"), [1540, 0]),
    http("Download", [1760, 0], "GET", "={{ $json.server }}/view?filename={{ encodeURIComponent($json.dl.filename) }}&subfolder={{ encodeURIComponent($json.dl.subfolder) }}&type={{ $json.dl.type }}",
         file_response=True, timeout=600000),
    write_file("Save file", "={{ $('Expand downloads').item.json.dl.dest }}", [1980, 0]),
    code("Saved", "return [{ json: { saved: $('Expand downloads').all().map((x) => x.json.dl.dest) } }];", [2200, 0]),
]
sub_pairs = [("When called", "Job"), ("Job", "Collect mode?"), ("Collect mode?", "Wait for job", 0), ("Collect mode?", "Read workflow files", 1),
             ("Read workflow files", "Parse workflow files"), ("Parse workflow files", "List uploads"), ("List uploads", "Read input file"),
             ("Read input file", "Upload to ComfyUI"), ("Upload to ComfyUI", "Collect uploads"), ("Collect uploads", "Build prompt"),
             ("Build prompt", "Queue job"), ("Queue job", "Submitted"),
             ("Wait for job", "Get history"), ("Get history", "Check job"), ("Check job", "Route"),
             ("Route", "Wait for job", 0), ("Route", "Job failed", 1), ("Route", "Expand downloads", 2),
             ("Expand downloads", "Download"), ("Download", "Save file"), ("Save file", "Saved")]
SUB_NOTE = ("## listing-heroes: ComfyUI job\nCalled by the GPU pipeline. Items are jobs: {server, workflow, params, dir, name, repo, mode}.\n\n"
            "- **mode submit**: uploads the input photos, fills the workflow from pipeline/comfyui/workflows, queues it, returns prompt_id.\n"
            "- **mode collect**: polls /history every 10 s, downloads every output to dir/name[-label].ext.\n\n"
            "Pure HTTP to ComfyUI: nothing to install.")

# ------------------------------------------------------------------ main: GPU pipeline
CONFIG_JS = ("// Edit these two lines, or POST {\"listing\": \"steinmann-106\"} to the webhook.\n"
             f"const repo = '{REPO}';\n"
             "const listing = ($json.body && $json.body.listing) || $json.listing || '" + DEFAULT_LISTING + "';\n"
             "return [{ json: { repo, listing } }];")
main_nodes = [
    node("Run manually", "n8n-nodes-base.manualTrigger", 1, {}, [0, 200]),
    node("Webhook", "n8n-nodes-base.webhook", 2, {"httpMethod": "POST", "path": "listing-heroes-gpu", "options": {}}, [0, 400],
         webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "lh-webhook-gpu"))),
    code("Config", CONFIG_JS, [220, 300]),
    read_file("Read listing", "={{ $json.repo }}/pipeline/listings/{{ $json.listing }}.json", [440, 300]),
    node("Parse listing", "n8n-nodes-base.extractFromFile", 1, {"operation": "fromJson", "options": {}}, [660, 300]),
    node("Make output folders", "n8n-nodes-base.executeCommand", 1, {"command": "=cd {{ $('Config').first().json.repo }} && python3 pipeline/run_listing.py pipeline/listings/{{ $('Config').first().json.listing }}.json --mkdir-only"}, [770, 520], executeOnce=True),
    code("Plan jobs", JS("plan_jobs.js"), [880, 300]),
    node("Submit all jobs", "n8n-nodes-base.executeWorkflow", 1.1, {"source": "database", "workflowId": {"__rl": True, "value": SUB_ID, "mode": "id"}, "mode": "once", "options": {"waitForSubWorkflow": True}}, [1100, 300]),
    node("Wait for all jobs", "n8n-nodes-base.executeWorkflow", 1.1, {"source": "database", "workflowId": {"__rl": True, "value": SUB_ID, "mode": "id"}, "mode": "once", "options": {"waitForSubWorkflow": True}}, [1320, 300]),
    node("Depth to disparity", "n8n-nodes-base.executeCommand", 1, {"command": "=cd {{ $('Config').first().json.repo }} && python3 pipeline/run_listing.py pipeline/listings/{{ $('Config').first().json.listing }}.json --post-only"}, [1540, 300], executeOnce=True),
    code("Plan interpolation", JS("plan_interp.js"), [1760, 300]),
    node("Submit interpolation", "n8n-nodes-base.executeWorkflow", 1.1, {"source": "database", "workflowId": {"__rl": True, "value": SUB_ID, "mode": "id"}, "mode": "once", "options": {"waitForSubWorkflow": True}}, [1980, 300]),
    node("Wait for interpolation", "n8n-nodes-base.executeWorkflow", 1.1, {"source": "database", "workflowId": {"__rl": True, "value": SUB_ID, "mode": "id"}, "mode": "once", "options": {"waitForSubWorkflow": True}}, [2200, 300]),
]
main_pairs = [("Run manually", "Config"), ("Webhook", "Config"), ("Config", "Read listing"), ("Read listing", "Parse listing"),
              ("Parse listing", "Make output folders"), ("Make output folders", "Plan jobs"), ("Plan jobs", "Submit all jobs"), ("Submit all jobs", "Wait for all jobs"),
              ("Wait for all jobs", "Depth to disparity"), ("Depth to disparity", "Plan interpolation"),
              ("Plan interpolation", "Submit interpolation"), ("Submit interpolation", "Wait for interpolation")]
MAIN_NOTE = ("## listing-heroes: GPU pipeline\n1. Set **repo** in Config (or POST {\"listing\": \"<id>\"} to the webhook).\n"
             "2. Run. Every job in pipeline/listings/<id>.json is queued on both ComfyUI servers at once, then collected.\n"
             "3. Depth maps are converted to disparity PNGs (Execute Command: start n8n with NODES_EXCLUDE=\"[]\").\n"
             "4. Transitions get a 50 fps copy.\n\nn8n needs N8N_RESTRICT_FILE_ACCESS_TO=<repo path> to read photos and write outputs.")

# ------------------------------------------------------------------ room copy (Claude API)
CLAUDE_HEADERS = {"anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01", "content-type": "application/json"}
copy_nodes = [
    node("Run manually", "n8n-nodes-base.manualTrigger", 1, {}, [0, 200]),
    node("Webhook", "n8n-nodes-base.webhook", 2, {"httpMethod": "POST", "path": "listing-heroes-copy", "options": {}}, [0, 400],
         webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "lh-webhook-copy"))),
    code("Config", CONFIG_JS, [220, 300]),
    read_file("Read listing", "={{ $json.repo }}/pipeline/listings/{{ $json.listing }}.json", [440, 300]),
    node("Parse listing", "n8n-nodes-base.extractFromFile", 1, {"operation": "fromJson", "options": {}}, [660, 300]),
    read_file("Read prompts", "={{ $('Config').first().json.repo }}/pipeline/copy/prompts.json", [880, 300], executeOnce=True),
    node("Parse prompts", "n8n-nodes-base.extractFromFile", 1, {"operation": "fromJson", "options": {}}, [1100, 300]),
    code("Copy config", JS("copy_config.js"), [1320, 300]),
    code("Room list", JS("room_list.js"), [1540, 300]),
    read_file("Read room photos", "={{ $json.path }}", [1760, 300]),
    code("Attach rooms", JS("attach_rooms.js"), [1980, 300]),
    code("Build draft request", JS("copy_request.js"), [2200, 300]),
    http("Draft copy (Claude)", [2420, 300], "POST", CLAUDE_URL, body="={{ JSON.stringify($json.body) }}",
         headers=CLAUDE_HEADERS, cred="Anthropic API key", timeout=600000),
    code("Read draft", JS("read_response.js"), [2640, 300], each=True),
    code("Build review request", JS("check_request.js"), [2860, 300]),
    http("Fair-housing review (Claude)", [3080, 300], "POST", CLAUDE_URL, body="={{ JSON.stringify($json.body) }}",
         headers=CLAUDE_HEADERS, cred="Anthropic API key", timeout=600000),
    code("Read review", JS("read_response.js"), [3300, 300], each=True),
    code("Final copy", JS("copy_result.js"), [3520, 300]),
    node("Make output folder", "n8n-nodes-base.executeCommand", 1, {"command": "=mkdir -p {{ $('Copy config').first().json.out_dir }}"}, [3630, 480], executeOnce=True),
    code("Rooms file", "return [$('Final copy').first()];", [3740, 480]),
    write_file("Save rooms.json", "={{ $('Copy config').first().json.out_dir }}/rooms.json", [3960, 480]),
]
copy_pairs = [("Run manually", "Config"), ("Webhook", "Config"), ("Config", "Read listing"), ("Read listing", "Parse listing"),
              ("Parse listing", "Read prompts"), ("Read prompts", "Parse prompts"), ("Parse prompts", "Copy config"),
              ("Copy config", "Room list"), ("Room list", "Read room photos"), ("Read room photos", "Attach rooms"),
              ("Attach rooms", "Build draft request"), ("Build draft request", "Draft copy (Claude)"), ("Draft copy (Claude)", "Read draft"),
              ("Read draft", "Build review request"), ("Build review request", "Fair-housing review (Claude)"),
              ("Fair-housing review (Claude)", "Read review"), ("Read review", "Final copy"), ("Final copy", "Make output folder"), ("Make output folder", "Rooms file"), ("Rooms file", "Save rooms.json")]
COPY_NOTE = ("## listing-heroes: room copy\nDrafts room-by-room copy from the room photos + MLS facts in the listing file, then a second "
             "Claude pass reviews it for fair-housing language and unsupported claims and returns corrected copy.\n\n"
             "Credential: **Header Auth** named \"Anthropic API key\", name `x-api-key`, value your key.\n\n"
             "Writes <out_dir>/rooms.json. Read it before it goes live: AI copy still needs a human check.")

if __name__ == "__main__":
    out = {"listing-heroes-comfyui-job.json": workflow("listing-heroes · ComfyUI job", sub_nodes, sub_pairs, SUB_ID, SUB_NOTE),
           "listing-heroes-gpu-pipeline.json": workflow("listing-heroes · GPU pipeline", main_nodes, main_pairs, "lhGpuPipeline001", MAIN_NOTE),
           "listing-heroes-room-copy.json": workflow("listing-heroes · room copy", copy_nodes, copy_pairs, "lhRoomCopy000001", COPY_NOTE)}
    for fn, wf in out.items():
        names = [n["name"] for n in wf["nodes"]]
        assert len(names) == len(set(names)), fn
        for src, c in wf["connections"].items():
            assert src in names, (fn, src)
            for outs in c["main"]:
                for d in outs:
                    assert d["node"] in names, (fn, d["node"])
        with open(os.path.join(OUT_DIR, fn), "w") as f:
            json.dump(wf, f, indent=2)
        print(fn, len(wf["nodes"]), "nodes")
