#!/usr/bin/env python3
"""Bundle tour pages for publishing.

  python3 build.py [slug ...]

pages/<slug>/index.html is a page body (starts with <title>, no <html>/<head>/<body>: the Artifact host adds them).
It loads the engine with <script src="../../engine/pano.js"></script> and reads media from
  const MEDIA = window.MEDIA_BASE || '../../media/<slug>';
dist/<slug>/index.html gets the engine inlined and MEDIA_BASE='media'; media files are listed in dist/<slug>/files.json
for the publish call. dist/<slug>/preview.html wraps the page in the same skeleton the host adds, for local screenshots
(serve tours/ and open /dist/<slug>/preview.html).
"""
import json, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = open(os.path.join(HERE, 'engine', 'pano.js')).read()
SKELETON = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
            '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
            'body{margin:0;font:14px system-ui,sans-serif;background:#fafaf8}img{max-width:100%}[hidden]{display:none!important}</style>'
            '</head><body>{page}</body></html>')


def build(slug):
    src = os.path.join(HERE, 'pages', slug, 'index.html')
    html = open(src).read()
    out = os.path.join(HERE, 'dist', slug)
    os.makedirs(out, exist_ok=True)
    tag = '<script src="../../engine/pano.js"></script>'
    assert tag in html, f'{slug}: engine script tag missing'
    page = html.replace(tag, '<script>window.MEDIA_BASE="media";\n' + ENGINE + '\n</script>')
    open(os.path.join(out, 'index.html'), 'w').write(page)
    # preview keeps relative media path into dist/<slug>/media (symlink)
    open(os.path.join(out, 'preview.html'), 'w').write(SKELETON.replace('{page}', page))
    media_src = os.path.join(HERE, 'media', slug)
    link = os.path.join(out, 'media')
    if os.path.islink(link) or os.path.exists(link):
        os.remove(link) if os.path.islink(link) else shutil.rmtree(link)
    os.symlink(os.path.relpath(media_src, out), link)
    # files actually referenced: everything in media/<slug> plus page-local assets in pages/<slug>/assets
    files = {}
    for f in sorted(os.listdir(media_src)):
        files[f'media/{f}'] = os.path.relpath(os.path.join(media_src, f), HERE)
    assets = os.path.join(HERE, 'pages', slug, 'assets')
    if os.path.isdir(assets):
        for f in sorted(os.listdir(assets)):
            files[f'assets/{f}'] = os.path.relpath(os.path.join(assets, f), HERE)
        al = os.path.join(out, 'assets')
        if os.path.islink(al): os.remove(al)
        if not os.path.exists(al): os.symlink(os.path.relpath(assets, out), al)
    size = sum(os.path.getsize(os.path.join(HERE, v)) for v in files.values())
    json.dump(files, open(os.path.join(out, 'files.json'), 'w'), indent=1)
    print(f'{slug}: page {len(page)//1024} KB, {len(files)} files, {size/1e6:.1f} MB')


if __name__ == '__main__':
    slugs = sys.argv[1:] or sorted(os.listdir(os.path.join(HERE, 'pages')))
    for s in slugs:
        build(s)
