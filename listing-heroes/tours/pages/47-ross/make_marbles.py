#!/usr/bin/env python3
"""Generate glass marbles (little-planet renders) for 47 Ross and the constellation layout.

Matches engine/pano.js exactly: camera pitch -PI/2 (+1e-3), yaw 0, k = 1. Pixel at normalized radius s in the
marble corresponds to the engine screen point |sp| = s * tan(THETA/2), so the page can start the engine at a fov
that lines up with the marble when the marble is scaled to cover the viewport.
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageFilter
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, '..', '..', 'media', '47-ross')
OUT = os.path.join(HERE, 'assets')
N = 512
THETA = math.radians(float(os.environ.get('THETA', 128)))  # polar angle (from nadir) at the marble edge
T = math.tan(THETA / 2)


def basis(yaw, pitch):
    f = np.array([math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)])
    r = np.array([-f[2], 0, f[0]]); r /= np.linalg.norm(r)
    u = np.cross(r, f) * -1  # engine: u = r x f with its own component order
    u = np.array([r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]])
    return r, u, f


def rays(n, scale):
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float64)
    sx = ((xs + .5) / n * 2 - 1)
    sy = 1 - (ys + .5) / n * 2
    s = np.sqrt(sx ** 2 + sy ** 2)
    return sx, sy, s


def sample(eq, d):
    h, w = eq.shape[:2]
    lon = np.arctan2(d[..., 0], -d[..., 2]); lat = np.arcsin(np.clip(d[..., 1], -1, 1))
    u = (0.5 + lon / (2 * np.pi)) * w - .5; v = (0.5 - lat / np.pi) * h - .5
    return cv2.remap(eq, u.astype(np.float32) % w, np.clip(v, 0, h - 1).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP), lat


def planet(eq, sx, sy, scale):
    r, u, f = basis(0.0, -math.pi / 2 + 1e-3)
    px, py = sx * scale, sy * scale
    D = r[None, None, :] * px[..., None] + u[None, None, :] * py[..., None] + f[None, None, :]
    D /= np.linalg.norm(D, axis=-1, keepdims=True)
    O = -f * 1.0
    b = (D * O).sum(-1); c = (O * O).sum() - 1
    t = -b + np.sqrt(np.maximum(b * b - c, 0))
    P = O + t[..., None] * D
    return sample(eq, P)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)


def marble(i):
    eqf = os.path.join(MEDIA, f'{i:02d}-sm.jpg')
    eq = cv2.cvtColor(cv2.imread(eqf), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    # nadir cap: replace the tripod with the floor ring (blurred) like the engine does
    h, w = eq.shape[:2]
    ss = 2  # supersample (1024 px work size)
    n = N * ss
    sx, sy, s = rays(n, T)
    # refraction rim: near the edge the glass squeezes the image, with slight colour split
    def warp(k):
        return 1 + k * smooth(.72, 1.0, s) * s ** 2
    chans = []
    for k in (0.10, 0.075, 0.05):
        w_ = warp(k)
        col, lat = planet(eq, sx * w_, sy * w_, T)
        chans.append((col, lat))
    col = np.stack([chans[0][0][..., 0], chans[1][0][..., 1], chans[2][0][..., 2]], -1)
    lat = chans[1][1]
    clean, _ = planet(eq, sx, sy, T)
    # floor colour per direction for the cap
    ring_v = int((0.5 + math.radians(58) / math.pi) * h)
    ring = eq[ring_v - 6:ring_v + 6].mean(0)  # (w,3)
    ring = cv2.GaussianBlur(ring[None], (0, 0), 18)[0]
    lon = np.arctan2(sx, sy)  # around the centre
    # map screen angle to equirect column: use the actual sampled lon by re-sampling at a fixed lat
    r_, u_, f_ = basis(0.0, -math.pi / 2 + 1e-3)
    dirx = r_[0] * sx + u_[0] * sy; dirz = r_[2] * sx + u_[2] * sy
    lon2 = np.arctan2(dirx, -dirz)
    cols = ((0.5 + lon2 / (2 * np.pi)) * w).astype(int) % w
    floorc = ring[cols]
    centre = ring.mean(0)
    a = smooth(math.radians(-62), math.radians(-74), lat)[..., None]
    m = smooth(math.radians(-72), math.radians(-88), lat)[..., None]
    cap = floorc * (1 - m * .5) + centre * (m * .5)
    col = col * (1 - a) + cap * a
    clean = np.clip(clean * (1 - a) + cap * a, 0, 1)
    Image.fromarray((clean * 255).astype(np.uint8), 'RGB').resize((768, 768), Image.LANCZOS).save(
        os.path.join(OUT, f'p{i:02d}.webp'), quality=78, method=6)
    # a touch more life in the colour
    lum = col.mean(-1, keepdims=True); col = np.clip(lum + (col - lum) * 1.12, 0, 1)
    # glass shading
    x, y = sx, sy
    rim = smooth(.55, 1.0, s)[..., None]
    col = col * (1 - .20 * rim ** 2.4)                    # darker rim
    col = col * (1 - .35 * rim ** 3) + np.array([.66, .72, .76]) * (.35 * rim ** 3) * col.mean(-1, keepdims=True) * 1.1  # cool glass tint at the rim
    col = col * (1 - .10 * smooth(.2, 1, (y * -.6 + x * .3 + .6) / 1.2)[..., None] * rim)  # lower right deeper
    # specular highlight top left (soft ellipse) + sharp core
    hx, hy = x + .38, y - .46
    rr = np.sqrt((hx / 1.0) ** 2 + (hy / .62) ** 2)
    spec = np.exp(-(rr / .30) ** 2) * .42 + np.exp(-(rr / .085) ** 2) * .55
    # faint inner reflection: a crescent along the lower right inside the rim
    cres = smooth(.80, .93, s) * (1 - smooth(.93, .99, s)) * smooth(-.1, .7, (x - y) / 1.414)
    win = np.exp(-((np.sqrt((x - .22) ** 2 + (y - .30) ** 2) - .0) / .05) ** 2) * 0
    col = col + (1 - col) * (spec + cres * .22)[..., None]
    # thin bright edge line
    edge = smooth(.975, .992, s) * (1 - smooth(.992, 1.0, s))
    col = col + (1 - col) * (edge * .35)[..., None]
    col = np.clip(col, 0, 1)
    alpha = 1 - smooth(1 - 2.0 / n, 1.0, s)
    rgba = np.concatenate([col, alpha[..., None]], -1)
    img = Image.fromarray((rgba * 255).astype(np.uint8), 'RGBA').resize((N, N), Image.LANCZOS)
    img.save(os.path.join(OUT, f'm{i:02d}.webp'), quality=82, method=6)
    return img


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    ids = [int(a) for a in sys.argv[1:]] or list(range(1, 23))
    for i in ids:
        marble(i); print('marble', i)
    print('THETA deg', math.degrees(THETA), 'T', T)
