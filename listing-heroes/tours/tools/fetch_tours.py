#!/usr/bin/env python3
"""Download the panoramas for every tour in data/<slug>/tour-data.json (public Ricoh360 S3 objects) and grade them
into media/<slug>/ (NN.jpg 4096 wide + NN-sm.jpg 1024). Then run layout.py for each slug.
  python3 tools/fetch_tours.py [slug ...]
"""
import json, os, subprocess, sys, urllib.request
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WB = {'vine-leaf': '1.0'}
for slug in sys.argv[1:] or sorted(os.listdir(os.path.join(HERE, 'data'))):
    d = json.load(open(os.path.join(HERE, 'data', slug, 'tour-data.json')))
    raw = os.path.join(HERE, 'data', slug, 'raw'); out = os.path.join(HERE, 'media', slug)
    os.makedirs(raw, exist_ok=True); os.makedirs(out, exist_ok=True)
    for r in d['rooms']:
        i = int(r['index']); o = r.get('enhanced') if isinstance(r.get('enhanced'), dict) else r['original']
        s3 = o.get('s3', o); src = os.path.join(raw, f'{i:02d}.jpg')
        if not os.path.exists(src):
            urllib.request.urlretrieve(f"https://{s3['bucket']}.s3.{s3['region']}.amazonaws.com/{s3['key']}", src)
        w = '4096' if r.get('projection') == 'EQUIRECT' else '2400'
        subprocess.run([sys.executable, os.path.join(HERE, 'tools', 'grade.py'), src, os.path.join(out, f'{i:02d}'), '--wb', WB.get(slug, '0.7'), '--w', w], check=True)
    subprocess.run([sys.executable, os.path.join(HERE, 'tools', 'layout.py'), os.path.join(HERE, 'data', slug, 'tour-data.json'), os.path.join(out, 'layout.json')], check=True)
    print(slug, 'done')
