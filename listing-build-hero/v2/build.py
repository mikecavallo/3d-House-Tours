#!/usr/bin/env python3
"""Bundle v2/index.html + src/*.js into one self-contained page.

usage: python3 build.py <out.html> [--artifact] [--neutral]
  --artifact  drop the <!doctype>/<html>/<head>/<body> wrapper (the artifact host adds its own)
  --neutral   replace the brokerage name with a placeholder
  --end MODE  render | photo: which ending to bake in
"""
import re, sys, pathlib

here = pathlib.Path(__file__).resolve().parent
src = (here / "index.html").read_text()
out_path = pathlib.Path(sys.argv[1])
artifact = "--artifact" in sys.argv
neutral = "--neutral" in sys.argv
end = sys.argv[sys.argv.index("--end") + 1] if "--end" in sys.argv else None

def inline(match):
    block = match.group(0)
    parts = []
    for name in re.findall(r'<script src="(src/[^"]+)"></script>', block):
        f = here / name
        if f.exists():
            js = f.read_text().replace("</script", "<\\/script")
            parts.append(f"<script>/* {name} */\n{js}\n</script>")
    return "\n".join(parts)

html = re.sub(r"<!--MODULES-->.*?<!--/MODULES-->", inline, src, flags=re.S)

if neutral:
    html = (html.replace('<span class="brand">Independent Realty Group</span>', '<span class="brand">Your Brokerage</span>')
                .replace("<span>Independent Realty Group · Office", "<span>Your Brokerage · Office")
                .replace('id="sign-l1">INDEPENDENT<', 'id="sign-l1">YOUR<')
                .replace('id="sign-l2">REALTY GROUP<', 'id="sign-l2">BROKERAGE<'))

if end:
    assert end in ("render", "photo")
    html = re.sub(r'const END_MODE = "[a-z]+";', f'const END_MODE = "{end}";', html, count=1)

if artifact:
    html = re.sub(r"^<!doctype html>\s*<html[^>]*>\s*<head>\s*<meta charset=\"utf-8\">\s*<meta name=\"viewport\"[^>]*>\s*", "", html, flags=re.I)
    html = html.replace("</head>\n<body>\n", "").replace("</body>\n</html>\n", "")

out_path.write_text(html)
print(f"wrote {out_path} ({len(html):,} bytes)")
