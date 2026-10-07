#!/usr/bin/env python3
"""Assemble each hero page: inline the shared CSS, listing section and scripts.

usage: python3 build.py [--artifact] [page ...]
  writes dist/<page>/index.html plus a media/ folder holding only the files that page uses.
  --artifact drops the <!doctype>/<html>/<head>/<body> wrapper (the artifact host adds its own).
"""
import re, sys, shutil, pathlib
here = pathlib.Path(__file__).resolve().parent
artifact = "--artifact" in sys.argv
bundle = "--bundle" in sys.argv
pages = [a for a in sys.argv[1:] if not a.startswith("--")] or ["flythrough", "dusk", "living", "parallax", "index"]
LINEUP = [("flythrough", "Fly-through"), ("dusk", "Day to dusk"), ("living", "Living photo"), ("parallax", "Depth story"), ("index", "All styles")]
DISCLOSE = {
  "flythrough": "The fly-through is built from the listing photos with a depth map, so the camera can move between them. Nothing in the house was added or removed.",
  "dusk": "Twilight view is a digital rendering made from a daytime listing photo. Window glow and sky are simulated; the house, yard and landscaping are unchanged.",
  "living": "Living photo: subtle motion (clouds, leaves, curtains) is animated from a single listing photo. Nothing in the property was added or removed.",
  "parallax": "Depth story: listing photos shown with a simulated 3D parallax. Nothing in the property was added or removed.",
  "index": "",
}
shared_css = (here/"shared/chrome.css").read_text()
listing = (here/"shared/listing.html").read_text()
scripts = {"depthcam": (here/"shared/depthcam.js").read_text(), "listing": (here/"shared/listing.js").read_text()}
for page in pages:
    src_path = here/page/"index.src.html" if page != "index" else here/"index.src.html"
    html = src_path.read_text()
    cur = ' aria-current="page"'
    lineup = "".join(f'<a href="../{slug}/"{cur if slug == page else ""}>{name}</a>' for slug, name in LINEUP if slug != "index")
    lst = listing.replace("{{DISCLOSE}}", DISCLOSE.get(page, "")).replace("{{LINEUP}}", lineup)
    html = html.replace("/*SHARED_CSS*/", shared_css).replace("<!--LISTING-->", lst)
    html = html.replace("<!--SCRIPTS-->", "".join(f"<script>/* {k} */\n{v}\n</script>\n" for k, v in scripts.items()))
    if bundle:
        # one artifact: index.html at the root, each style in its own folder, one shared media/ folder
        out = here/"dist"/"bundle" if page == "index" else here/"dist"/"bundle"/page
        out.mkdir(parents=True, exist_ok=True)
        html = re.sub(r'href="\.\./(\w+)/"', r'href="../\1/index.html"', html)
        if page != "index":
            html = html.replace("media/", "../media/").replace('<nav class="lineup" aria-label="Other hero styles for this listing">', '<nav class="lineup" aria-label="Other hero styles for this listing"><a href="../index.html">All styles</a>')
    else:
        out = here/"dist"/page; out.mkdir(parents=True, exist_ok=True)
    used = sorted(set(re.findall(r"media/([\w.\-]+\.(?:jpg|png|mp3))", html)))
    # media referenced from script template strings like `media/${n}.jpg`
    for m in re.findall(r"\[([^\]]*)\]\.map\(n => eng\.add\(n, `(?:\.\./)?media/\$\{n\}\.jpg`", html):
        for n in re.findall(r'"([\w-]+)"', m): used += [f"{n}.jpg", f"{n}-depth.png"]
    used += re.findall(r'MEDIA:([\w.\-]+)', html)
    used += re.findall(r'"media/([\w.\-]+\.(?:jpg|png|mp3))"', html)
    mdir = (here/"dist"/"bundle"/"media") if bundle else (out/"media")
    mdir.mkdir(parents=True, exist_ok=True)
    for f in sorted(set(used)):
        if (here/"media"/f).exists(): shutil.copy2(here/"media"/f, mdir/f)
        else: print("  missing media:", f)
    if artifact and (not bundle or page == "index"):
        html = re.sub(r"^<!doctype html>\s*<html[^>]*>\s*<head>\s*<meta charset=\"utf-8\">\s*<meta name=\"viewport\"[^>]*>\s*", "", html, flags=re.I)
        html = html.replace("</head>\n<body>\n", "").replace("</body>\n</html>\n", "")
    (out/"index.html").write_text(html)
    print(f"wrote dist/{page}/index.html ({len(html):,} bytes, {len(set(used))} media files)")
