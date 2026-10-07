"""Build a disparity map (255 = near) for a photo from a hand-authored scene spec.

Pop-up model ("tour into the picture"): ground/floor pixels get disparity from their height
below the horizon; vertical pixels take the disparity of the ground they stand on (per-column
contact scanned bottom-up); ceiling pixels get disparity from their height above the horizon;
fixed polygons get a constant; sky is 0. Layers paint in order, later wins. The result is
snapped to photo edges with a guided filter.
"""
import cv2, json, sys, numpy as np

W, H = 960, 600          # working size (16:10)

def poly_mask(pts):
    m = np.zeros((H, W), np.uint8)
    p = np.array([[x/100*W, y/100*H] for x, y in pts], np.int32)
    cv2.fillPoly(m, [p], 1)
    return m.astype(bool)

def build(name, spec):
    img = cv2.imread(f"photos/{name}.jpg")
    small = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
    hz = spec["horizon"]/100
    ceil_k = spec.get("ceilK", 1.6)
    # classes: 0 vertical, 1 ground, 2 fixed, 3 sky, 4 ceiling
    cls = np.zeros((H, W), np.uint8)
    fixed = np.zeros((H, W), np.float32)
    skyok = np.zeros((H, W), bool)
    nosnap = np.zeros((H, W), np.float32)
    for L in spec["layers"]:
        m = poly_mask(L["poly"])
        t = {"vertical":0, "ground":1, "fixed":2, "sky":3, "ceiling":4, "grad":2}[L["type"]]
        cls[m] = t
        skyok[m] = bool(L.get("sky", False))
        if L.get("nosnap"): nosnap[m] = 1
        if L["type"] == "fixed": fixed[m] = L["d"]
        elif L["type"] == "grad":
            (x0, y0), (x1, y1) = L["p0"], L["p1"]
            gx, gy = np.meshgrid(np.arange(W)/W*100, np.arange(H)/H*100)
            vx, vy = x1-x0, y1-y0
            t01 = np.clip(((gx-x0)*vx + (gy-y0)*vy)/(vx*vx+vy*vy), 0, 1)
            fixed[m] = (L["d0"] + (L["d1"]-L["d0"])*t01)[m]
    if spec.get("skyauto"):
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV).astype(np.float32)/255
        b = small.astype(np.float32)/255
        bright = (hsv[...,2] > spec.get("skyV", .78)) & ((hsv[...,1] < .22) | ((b[...,0] > b[...,2]+.04) & (hsv[...,2] > .6)))
        bright = cv2.morphologyEx(bright.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2,2),np.uint8)).astype(bool)
        allowed = skyok | (cls == 3)
        rows = np.arange(H)[:, None] < spec.get("skyMaxY", 60)/100*H
        cls[bright & allowed & rows] = 3
    y = (np.arange(H, dtype=np.float32)[:, None] + .5)/H
    gd = np.clip((y - hz)/(1 - hz), 0, None) * np.ones((1, W), np.float32)
    cd = np.clip((hz - y)/(1 - hz), 0, None) * ceil_k * np.ones((1, W), np.float32)
    d = np.zeros((H, W), np.float32)
    # bottom-up contact for vertical pixels
    contact = np.full(W, gd[-1, 0] if hz < 1 else 1.0, np.float32)
    contact[:] = 1.0
    for r in range(H-1, -1, -1):
        c = cls[r]
        g = c == 1
        contact[g] = gd[r, g]
        v = c == 0
        d[r, v] = contact[v]
        d[r, g] = gd[r, g]
        f = c == 2
        d[r, f] = fixed[r, f]
        ce = c == 4
        d[r, ce] = cd[r, ce]
    # top-down pass: vertical pixels hanging from a ceiling (upper walls with no floor contact)
    if (cls == 4).any():
        top = np.full(W, -1.0, np.float32)
        for r in range(H):
            c = cls[r]
            ce = c == 4
            top[ce] = cd[r, ce]
            v = (c == 0) & (top >= 0)
            if v.any(): d[r, v] = np.where(d[r, v] >= .999, top[v], d[r, v])
    d[cls == 3] = 0
    skym = cv2.GaussianBlur((cls == 3).astype(np.float32), (0, 0), 1.2)
    cv2.imwrite(f"maps/{name}-sky.png", np.clip(skym*255, 0, 255).astype(np.uint8))
    d = np.nan_to_num(d, nan=0.0)
    d = np.clip(d * spec.get("scale", 1.0), 0, 1)
    # snap to edges
    guide = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)/255
    raw = d.astype(np.float32)
    g = cv2.ximgproc.guidedFilter(guide, raw, spec.get("gr", 6), spec.get("geps", 1e-3))
    g = np.nan_to_num(g, nan=0.0)
    # only let the photo's edges move depth where the depth itself has a step (object outlines);
    # inside smooth regions keep the authored depth so windows and siding don't ripple
    gx = cv2.Sobel(raw, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(raw, cv2.CV_32F, 0, 1, ksize=3)
    step = (np.hypot(gx, gy) > 0.08).astype(np.uint8)
    near = cv2.dilate(step, np.ones((2*spec.get("gr", 6)+1,)*2, np.uint8)).astype(np.float32)
    near = cv2.GaussianBlur(near, (0, 0), 3)
    near *= 1 - cv2.GaussianBlur(nosnap, (0, 0), 2)   # "nosnap" layers keep their authored edges (railings, balusters)
    d = raw*(1 - near) + g*near
    d = cv2.GaussianBlur(d, (0, 0), 1.0)
    d8 = np.clip(d*255, 0, 255).astype(np.uint8)
    cv2.imwrite(f"maps/{name}-depth.png", d8)
    # preview: photo | colormap blend
    cm = cv2.applyColorMap(d8, cv2.COLORMAP_TURBO)
    blend = cv2.addWeighted(small, .45, cm, .55, 0)
    for L in spec["layers"]:
        p = np.array([[x/100*W, yy/100*H] for x, yy in L["poly"]], np.int32)
        cv2.polylines(blend, [p], True, (255,255,255), 1)
    cv2.imwrite(f"prev/depth-{name}.jpg", np.vstack([cv2.resize(blend, (W, H)), ]), [cv2.IMWRITE_JPEG_QUALITY, 85])
    return d8

if __name__ == "__main__":
    # python3 depth.py [names...]            -> specs from scenes.json
    # python3 depth.py --spec specs/x.json x -> one spec file
    args = sys.argv[1:]
    if args and args[0] == "--spec":
        build(args[2], json.load(open(args[1]))); print("built", args[2])
    else:
        specs = json.load(open("scenes.json"))
        for n in (args or specs.keys()):
            build(n, specs[n]); print("built", n)
