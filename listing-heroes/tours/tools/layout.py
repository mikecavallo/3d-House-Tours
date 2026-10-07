#!/usr/bin/env python3
"""Reassemble a 360 tour's floor layout from its hotspot geometry.
Pitch is flipped to + up on read (Ricoh stores + down). Each Tourpath hotspot gives the bearing (yaw) from room A to room B in A's panorama; when it sits on the floor
(pitch < 0) it also gives distance = camera_height / tan(-pitch). Pairs A->B and B->A fix the relative heading
of the two panoramas. Solves headings (circular LS) then positions (linear LS).
  python3 layout.py tour-data.json out.json
"""
import json, math, sys, numpy as np
H = 1.55
d = json.load(open(sys.argv[1]))
rooms = d['rooms']; ids = [r['id'] for r in rooms]; ix = {r['id']: i for i, r in enumerate(rooms)}
n = len(rooms)
E = []  # (a, b, yaw, pitch)
for r in rooms:
    for hs in r['hotspots']:
        if 'toRoom' in hs and hs['toRoom']['id'] in ix and 'yaw' in hs['position']:
            E.append((ix[r['id']], ix[hs['toRoom']['id']], hs['position']['yaw'], -hs['position']['pitch']))  # Ricoh pitch is + down; we use + up
ed = {}
for a, b, y, p in E: ed.setdefault((a, b), (y, p))
# heading constraints
C = []
for (a, b), (y, p) in ed.items():
    if (b, a) in ed and a < b:
        C.append((a, b, y - ed[(b, a)][0] + math.pi))
wrap = lambda t: (t + math.pi) % (2 * math.pi) - math.pi
th = [None] * n
adj = {}
for a, b, c in C: adj.setdefault(a, []).append((b, c)); adj.setdefault(b, []).append((a, -c))
comp = [-1] * n; ncomp = 0
for s in range(n):
    if th[s] is not None: continue
    th[s] = 0.0; comp[s] = ncomp; q = [s]
    while q:
        u = q.pop()
        for v, c in adj.get(u, []):
            if th[v] is None: th[v] = th[u] + c; comp[v] = ncomp; q.append(v)
    ncomp += 1
for it in range(200):  # refine
    for u in range(n):
        if u not in adj: continue
        s = sum(math.e ** (1j * (th[v] - c)) for v, c in adj[u]) + 0.5 * math.e ** (1j * th[u])
        th[u] = math.atan2(s.imag, s.real)
# positions
rowsA = []; rowsb = []; w = []
for (a, b), (y, p) in ed.items():
    if comp[a] != comp[b]: continue
    bear = th[a] + y
    if p < -0.06: dist = min(H / math.tan(-p), 12); wt = 1.0
    else: dist = 4.0; wt = 0.15
    for k, f in ((0, math.cos), (1, math.sin)):
        row = np.zeros(2 * n); row[2 * b + k] = 1; row[2 * a + k] = -1
        rowsA.append(row); rowsb.append(dist * f(bear)); w.append(wt)
for c in range(ncomp):  # anchor each component
    s = comp.index(c)
    for k in (0, 1):
        row = np.zeros(2 * n); row[2 * s + k] = 1; rowsA.append(row); rowsb.append(0); w.append(10)
A = np.array(rowsA) * np.array(w)[:, None]; bb = np.array(rowsb) * np.array(w)
P = np.linalg.lstsq(A, bb, rcond=None)[0].reshape(n, 2)
res = []
for i, r in enumerate(rooms):
    res.append({"i": int(r['index']), "id": r['id'], "name": r['name'], "heading": wrap(th[i]),
                "x": round(float(P[i, 0]), 3), "y": round(float(P[i, 1]), 3), "comp": comp[i],
                "links": [{"to": int(rooms[b]['index']), "yaw": round(y, 4), "pitch": round(p, 4)} for (a, b), (y, p) in ed.items() if a == i],
                "notes": [{"title": hs.get('title'), "text": hs.get('description'), "yaw": hs['position']['yaw'], "pitch": -hs['position']['pitch']}
                          for hs in r['hotspots'] if hs.get('__typename') == 'TextAnnotation' and 'yaw' in hs['position']],
                "flat": r.get('projection') != 'EQUIRECT'})
resid = []
for a, b, c in C: resid.append(abs(wrap(th[b] - th[a] - c)))
print(f"{d['name']}: {n} rooms, {len(ed)} links, {len(C)} pairs, comps={ncomp}, heading resid median {np.degrees(np.median(resid) if resid else 0):.1f} deg")
json.dump({"name": d['name'], "address": d['address'], "photographer": d['photographer'], "description": d.get('description'), "rooms": res},
          open(sys.argv[2], 'w'), indent=1)
