# Room positions on media/mission-house/floorplan.jpg (pixels, 1621x2048), placed by hand from the plan and the
# panoramas, then the plan rotation is fitted from the door links (same-floor only).
import json, math, numpy as np
P = {1:(944,1843,2), 2:(942,1475,2), 3:(789,1454,2), 4:(717,1536,2), 5:(968,1270,2), 6:(707,1218,2), 7:(922,1126,2),
     8:(932,922,2), 9:(983,840,2), 10:(758,922,2), 11:(717,819,2), 12:(758,1024,2),
     13:(1362,1075,3), 14:(1362,932,3), 15:(1342,809,3), 16:(1362,1210,3), 17:(1382,1638,3), 18:(1362,1420,3), 19:(1280,1024,3),
     20:(204,1004,1), 21:(296,1075,1), 22:(434,901,1), 23:(459,1096,1), 24:(444,1331,1), 25:(490,1188,1), 26:(220,819,1),
     27:(214,1198,1), 28:(429,665,1), 29:(286,430,1), 30:(368,256,1)}
L = json.load(open('media/mission-house/layout.json'))
R = {r['i']: r for r in L['rooms']}
d = []
for r in L['rooms']:
    for l in r['links']:
        a, b = r['i'], l['to']
        if a not in P or b not in P or P[a][2] != P[b][2] or R[a]['comp'] != R[b]['comp'] or R[a]['flat']: continue
        dx, dy = P[b][0]-P[a][0], P[b][1]-P[a][1]
        if math.hypot(dx, dy) < 40: continue
        d.append((a, b, math.atan2(dy, dx) - (R[a]['heading'] + l['yaw'])))
z = np.exp(1j*np.array([x[2] for x in d]))
phi = np.angle(z.mean()); res = np.degrees(np.abs(np.angle(z*np.exp(-1j*phi))))
print('edges', len(d), 'phi', round(math.degrees(phi),1), 'resid median', round(float(np.median(res)),1), 'p80', round(float(np.percentile(res,80)),1))
for (a,b,_),e in zip(d,res):
    if e > 35: print('  off', a, R[a]['name'], '->', b, R[b]['name'], round(float(e)))
# per-room mean error
from collections import defaultdict
pr = defaultdict(list)
for (a,b,_),e in zip(d,res): pr[a].append(e); pr[b].append(e)
print({k: round(float(np.median(v))) for k,v in sorted(pr.items())})
json.dump({'phi': phi, 'size': [1621, 2048], 'rooms': {k: v for k, v in P.items()}}, open('media/mission-house/plan.json', 'w'))

# refine: per room, grid-search its position (others fixed) to best match the door bearings, with a pull toward
# the hand placement. Bounding boxes keep each floor on its own drawing.
BOX = {1: (100, 80, 540, 1650), 2: (625, 690, 1060, 1850), 3: (1150, 690, 1490, 1700)}
def cost(k, x, y, P):
    c = 0.0; n = 0
    for r in (R[k],) + tuple(R[j] for j in P if j != k):
        a = r['i']
        if r['flat'] or a not in P: continue
        for l in r['links']:
            b = l['to']
            if b not in P or (a != k and b != k) or P[a][2] != P[b][2]: continue
            ax, ay = (x, y) if a == k else P[a][:2]; bx, by = (x, y) if b == k else P[b][:2]
            if math.hypot(bx-ax, by-ay) < 30: continue
            e = math.atan2(by-ay, bx-ax) - (R[a]['heading'] + l['yaw'] + phi)
            c += 1 - math.cos(e); n += 1
    return c / max(n, 1)
H = dict(P)
for it in range(4):
    for k in sorted(P):
        if R[k]['flat']: continue
        f = P[k][2]; x0, y0, x1, y1 = BOX[f]; best = None
        for x in range(x0, x1, 18):
            for y in range(y0, y1, 18):
                c = cost(k, x, y, P) + 0.25 * (math.hypot(x - H[k][0], y - H[k][1]) / 250) ** 2
                if best is None or c < best[0]: best = (c, x, y)
        P[k] = (best[1], best[2], f)
print({k: v[:2] for k, v in P.items()})
json.dump({'phi': phi, 'size': [1621, 2048], 'rooms': {k: v for k, v in P.items()}}, open('media/mission-house/plan.json', 'w'))
from PIL import Image, ImageDraw
im = Image.open('media/mission-house/floorplan.jpg').convert('RGB'); dr = ImageDraw.Draw(im)
for k, (x, y, f) in P.items():
    dr.ellipse([x-12, y-12, x+12, y+12], fill=(220, 40, 40)); dr.text((x+14, y-8), f'{k} {R[k]["name"]}', fill=(220, 40, 40))
    if not R[k]['flat']:
        t = R[k]['heading'] + phi; dr.line([x, y, x+45*math.cos(t), y+45*math.sin(t)], fill=(40, 90, 220), width=4)
im.save('/tmp/claude-0/plan_check.jpg', quality=85)
