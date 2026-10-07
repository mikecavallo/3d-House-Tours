"""CPU twin of the page's raymarch: render a photo from a moved camera, to check a depth map.

usage: python3 move.py <name> <out.jpg> "x,y,z,lookU,lookV,lookD,zoom" ["x,y,z,..."...]
  x right, y up, z forward (photo taken from 0,0,0). z 0.3-0.6 is a typical push-in.
  look* = a point on the photo (percent across, percent down, disparity 0-1) to aim at.
Writes one 640x360 frame per pose stacked vertically, each labelled with its pose.
Stretched smears = depth discontinuities the camera sees past; wavy straight lines = noisy depth.
"""
import cv2, numpy as np, sys
NEAR, F = 0.06, 1.35
name, out = sys.argv[1], sys.argv[2]
img = cv2.imread(f"photos/{name}.jpg")[:, :, ::-1].astype(np.float32)/255
dep = cv2.imread(f"maps/{name}-depth.png", 0).astype(np.float32)/255
IH, IW = img.shape[:2]; DH, DW = dep.shape; asp = IW/IH
def Zof(d): return 1/(NEAR + d*(1 - NEAR))
def dOf(z): return np.clip((1/z - NEAR)/(1 - NEAR), 0, 1)
def samp(tex, uv):
    h, w = tex.shape[:2]
    x = np.clip(uv[..., 0], 0, 1)*(w - 1); y = np.clip(1 - uv[..., 1], 0, 1)*(h - 1)
    return cv2.remap(tex, x.astype(np.float32), y.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
def P3(u, v, d):
    Z = Zof(d); return np.array([(u/100*2 - 1)*asp*Z/F, (1 - v/100*2)*Z/F, Z])
frames = []
for pose in sys.argv[3:]:
    x, y, z, lu, lv, ld, zoom = map(float, pose.split(","))
    cam = np.array([x, y, z]); t = P3(lu, lv, ld) - cam
    yaw = np.arctan2(t[0], t[2]); pitch = np.arctan2(t[1], np.hypot(t[0], t[2]))
    cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    W, H = 640, 360; va = W/H; cover = min(1, asp/va)
    vx, vy = np.meshgrid((np.arange(W) + .5)/W, (np.arange(H) + .5)/H); vy = 1 - vy
    sx = (vx*2 - 1)*va*cover; sy_ = (vy*2 - 1)*cover
    d = np.stack([sx/(F*zoom), sy_/(F*zoom), np.ones_like(sx)], -1)
    # pitch about x then yaw about y
    d = np.stack([d[..., 0], d[..., 1]*cp + d[..., 2]*sp, -d[..., 1]*sp + d[..., 2]*cp], -1)
    d = np.stack([d[..., 0]*cy + d[..., 2]*sy, d[..., 1], -d[..., 0]*sy + d[..., 2]*cy], -1)
    d = d/np.maximum(d[..., 2:3], 1e-3)
    d0 = dOf(max(z + 0.04, 1.0))
    def uvAt(dd):
        P = cam + d*(Zof(dd) - z)[..., None]
        q = F*P[..., :2]/P[..., 2:3]
        return np.stack([q[..., 0]/asp*.5 + .5, q[..., 1]*.5 + .5], -1)
    N = 56; prev = np.full((H, W), d0, np.float32); hit = np.zeros((H, W), bool); hd = np.zeros((H, W), np.float32)
    for i in range(1, N + 1):
        dr = d0*(1 - i/N)
        ds = samp(dep, uvAt(np.full((H, W), dr, np.float32)))
        new = (~hit) & (ds >= dr)
        hd[new] = dr; hit |= new
        prev = np.where(hit, prev, dr)
    lo, hi = np.where(hit, hd, 0), np.where(hit, prev, 0)
    for _ in range(6):
        m = (lo + hi)/2; ok = samp(dep, uvAt(m)) >= m
        lo = np.where(ok, m, lo); hi = np.where(ok, hi, m)
    col = samp(img, uvAt(lo))
    fr = (np.clip(col, 0, 1)[:, :, ::-1]*255).astype(np.uint8)
    cv2.putText(fr, pose, (6, 18), 0, .5, (0, 0, 0), 3); cv2.putText(fr, pose, (6, 18), 0, .5, (255, 255, 255), 1)
    frames.append(fr)
cv2.imwrite(out, np.vstack(frames), [cv2.IMWRITE_JPEG_QUALITY, 85])
print("wrote", out)
