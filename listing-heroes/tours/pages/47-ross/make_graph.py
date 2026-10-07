#!/usr/bin/env python3
"""Force-directed constellation layout for 47 Ross, seeded from the solved x/y in layout.json."""
import json, os, math
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
L = json.load(open(os.path.join(HERE, '..', '..', 'media', '47-ross', 'layout.json')))
rooms = L['rooms']; ids = [r['i'] for r in rooms]; ix = {i: k for k, i in enumerate(ids)}
E = set()
for r in rooms:
    for l in r['links']:
        a, b = sorted((r['i'], l['to'])); E.add((a, b))
E = sorted(E)
deg = np.zeros(len(ids))
for a, b in E: deg[ix[a]] += 1; deg[ix[b]] += 1
rad = 0.55 + 0.11 * deg   # marble radius in layout units
P0 = np.array([[r['x'], -r['y']] for r in rooms], float)
P0 = (P0 - P0.mean(0)) / P0.std() * 3
ASP = 1.75

def cross(P):
    n = 0
    for x, (a, b) in enumerate(E):
        for (c_, d_) in E[x + 1:]:
            if len({a, b, c_, d_}) < 4: continue
            p1, p2, p3, p4 = P[ix[a]], P[ix[b]], P[ix[c_]], P[ix[d_]]
            def o(p, q, r): return np.sign((q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0]))
            if o(p1, p2, p3) != o(p1, p2, p4) and o(p3, p4, p1) != o(p3, p4, p2): n += 1
    return n

def sim(P, iters=2500):
  P = P.copy()
  for it in range(iters):
      F = np.zeros_like(P)
      d = P[:, None] - P[None]
      dist = np.linalg.norm(d, axis=-1) + np.eye(len(P))
      minD = rad[:, None] + rad[None] + 1.3  # room for labels
      rep = 2.2 / dist ** 2 + 6 * np.maximum(0, minD - dist)
      np.fill_diagonal(rep, 0)
      F += (d / dist[..., None] * rep[..., None]).sum(1)
      for a, b in E:
          i, j = ix[a], ix[b]; v = P[j] - P[i]; l = np.linalg.norm(v) + 1e-9
          leaf = min(deg[i], deg[j]) == 1
          rest = rad[i] + rad[j] + (1.3 if leaf else 1.9)
          f = (.6 if leaf else .25) * (l - rest) * v / l
          F[i] += f; F[j] -= f
      # anisotropic gravity: pull toward an ellipse with the target aspect
      F[:, 0] -= .012 * P[:, 0]
      F[:, 1] -= .040 * P[:, 1]
      step = .08 * (1 - it / iters) + .005
      P += np.clip(F, -1, 1) * step
  return P

best = None
for seed in range(140):
    rng = np.random.default_rng(seed)
    Q = sim(P0 * (1 if seed < 10 else 0.3) + rng.normal(0, .3 + seed * .08, P0.shape))
    Q = Q - Q.mean(0)
    ba = None
    for deg_ in range(0, 180, 3):
        a_ = math.radians(deg_); Rm = np.array([[math.cos(a_), -math.sin(a_)], [math.sin(a_), math.cos(a_)]])
        Z = Q @ Rm.T; sp_ = (Z + rad[:, None]).max(0) - (Z - rad[:, None]).min(0); asp = sp_[0] / sp_[1]
        e = abs(math.log(asp / ASP))
        if ba is None or e < ba[0]: ba = (e, Z)
    Q = ba[1]
    hits = 0
    for a, b in E:
        p1, p2 = Q[ix[a]], Q[ix[b]]
        for k in range(len(ids)):
            if ids[k] in (a, b): continue
            v = p2 - p1; t = np.clip(np.dot(Q[k] - p1, v) / np.dot(v, v), 0, 1)
            if np.linalg.norm(p1 + t * v - Q[k]) < rad[k] * 1.35: hits += 1
    sc = cross(Q) + 40 * ba[0] + 8 * hits
    if best is None or sc < best[0]: best = (sc, Q, seed)
print('score', best[0], 'seed', best[2])
P = best[1]
# stretch toward the hero's wide aspect
sp_ = (P + rad[:, None]).max(0) - (P - rad[:, None]).min(0)
P[:, 0] *= max(1.0, ASP / (sp_[0] / sp_[1]))
# pick the mirror that leaves the top-left (title block) emptiest
ZX, ZY = .30, .40
def zone_cost(Q):
    mn = (Q - rad[:, None]).min(0); mx = (Q + rad[:, None]).max(0); sp = mx - mn
    u = (Q - mn) / sp
    return sum(max(0, ZX - (u[k, 0] - rad[k] / sp[0])) * max(0, ZY - (u[k, 1] - rad[k] / sp[1])) for k in range(len(Q)))
P = min((P * np.array(f) for f in [(1, 1), (-1, 1), (1, -1), (-1, -1)]), key=zone_cost)
print('zone cost', zone_cost(P))
# relax: springs, overlap removal, and a soft push out of the title zone
for it in range(900):
    F = np.zeros_like(P)
    d = P[:, None] - P[None]; dist = np.linalg.norm(d, axis=-1) + np.eye(len(P))
    minD = rad[:, None] + rad[None] + 1.3
    push = np.maximum(0, minD - dist) * 3; np.fill_diagonal(push, 0)
    F += (d / dist[..., None] * push[..., None]).sum(1)
    for a, b in E:
        i, j = ix[a], ix[b]; v = P[j] - P[i]; l = np.linalg.norm(v) + 1e-9
        leaf = min(deg[i], deg[j]) == 1
        rest = rad[i] + rad[j] + (1.3 if leaf else 1.9)
        f = .08 * max(0, l - rest * 1.4) * v / l
        F[i] += f; F[j] -= f
    mn = (P - rad[:, None]).min(0); mx = (P + rad[:, None]).max(0); sp = mx - mn
    for k in range(len(P)):
        ux = (P[k, 0] - rad[k] - mn[0]) / sp[0]; uy = (P[k, 1] - rad[k] - mn[1]) / sp[1]
        if ux < ZX and uy < ZY:
            # leave by the closer side
            if (ZX - ux) * sp[0] < (ZY - uy) * sp[1]: F[k, 0] += .6
            else: F[k, 1] += .6
    P += np.clip(F, -1, 1) * .05
sp_ = (P + rad[:, None]).max(0) - (P - rad[:, None]).min(0)
P[:, 0] *= max(1.0, ASP / (sp_[0] / sp_[1]))
for it in range(400):
    d = P[:, None] - P[None]; dist = np.linalg.norm(d, axis=-1) + np.eye(len(P))
    minD = rad[:, None] + rad[None] + 1.3
    push = np.maximum(0, minD - dist); np.fill_diagonal(push, 0)
    P += (d / dist[..., None] * push[..., None]).sum(1) * .05
print('zone cost after', zone_cost(P))
c = P - P.mean(0)
mn = (c - rad[:, None]).min(0); mx = (c + rad[:, None]).max(0)
span = mx - mn
out = {'aspect': float(span[0] / span[1]), 'unit': float(1 / span[0]),
       'nodes': [{'i': ids[k], 'x': float((c[k, 0] - mn[0]) / span[0]), 'y': float((c[k, 1] - mn[1]) / span[1]),
                  'r': float(rad[k] / span[0]), 'deg': int(deg[k])} for k in range(len(ids))],
       'edges': [list(e) for e in E]}
json.dump(out, open(os.path.join(HERE, 'assets', 'graph.json'), 'w'), separators=(',', ':'))
print(len(E), 'edges, aspect', out['aspect'])
# preview
from PIL import Image, ImageDraw
W = 1400; H = int(W / out['aspect'])
im = Image.new('RGB', (W + 200, H + 200), 'white'); dr = ImageDraw.Draw(im)
pos = {n['i']: (100 + n['x'] * W, 100 + n['y'] * H, n['r'] * W) for n in out['nodes']}
for a, b in E: dr.line([pos[a][:2], pos[b][:2]], fill=(170, 170, 170))
for r in rooms:
    x, y, rr = pos[r['i']]; dr.ellipse([x - rr, y - rr, x + rr, y + rr], outline='black'); dr.text((x + rr + 4, y), r['name'], fill='black')
im.save('/tmp/claude-0/-home-user-CAD-slides/10cdeea3-449c-50cf-8da2-30420cad9439/scratchpad/ross/graph.png')
