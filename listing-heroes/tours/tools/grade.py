#!/usr/bin/env python3
"""Pro grade for equirect panoramas: neutral white balance, local contrast, vibrance, gentle S-curve.
Seam-safe (wrap-padded). Writes web sizes.
  python3 grade.py SRC.jpg OUT_BASE [--wb 0.8]   -> OUT_BASE.jpg (4096) and OUT_BASE-sm.jpg (1024)
"""
import sys, argparse, numpy as np, cv2
cv2.setNumThreads(4)

def grade(img, wb=0.8, clahe=0.45, vib=0.14):
    h, w = img.shape[:2]
    pad = w // 16
    x = np.concatenate([img[:, -pad:], img, img[:, :pad]], 1).astype(np.float32) / 255.0
    # robust neutral: low-sat midtone pixels
    hsv = cv2.cvtColor(x, cv2.COLOR_BGR2HSV)
    m = (hsv[..., 1] < 0.18) & (hsv[..., 2] > 0.35) & (hsv[..., 2] < 0.92)
    m[: int(h * 0.15)] = False; m[int(h * 0.85):] = False  # skip ceiling lights / tripod
    if m.sum() > 2000:
        mean = x[m].mean(0)
        gain = mean.mean() / mean
        gain = 1 + (gain - 1) * wb
        x = x * gain[None, None, :]
    # exposure: put the 99.3 percentile near 0.97 (no clipping push)
    lum = x.mean(2)
    p = np.percentile(lum[int(h*0.1):int(h*0.9)], 99.3)
    if p < 0.97: x = x * min(1.25, 0.97 / max(p, 1e-3))
    x = np.clip(x, 0, 1)
    # local contrast on L
    lab = cv2.cvtColor(x, cv2.COLOR_BGR2LAB)
    L = lab[..., 0] / 100.0
    L8 = (L * 255).astype(np.uint8)
    cl = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 16)).apply(L8).astype(np.float32) / 255.0
    L2 = L * (1 - clahe) + cl * clahe
    # gentle S-curve around 0.5
    L2 = L2 + 0.10 * (L2 - 0.5) * (1 - np.abs(2 * L2 - 1))
    lab[..., 0] = np.clip(L2, 0, 1) * 100
    # vibrance: boost low-chroma more
    a, b = lab[..., 1], lab[..., 2]
    c = np.sqrt(a * a + b * b)
    k = 1 + vib * (1 - np.clip(c / 60, 0, 1))
    lab[..., 1] = a * k; lab[..., 2] = b * k
    y = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
    y = np.clip(y[:, pad:pad + w] * 255 + 0.5, 0, 255).astype(np.uint8)
    return y

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--wb", type=float, default=0.8); ap.add_argument("--w", type=int, default=4096)
    ap.add_argument("--q", type=int, default=82); ap.add_argument("--raw", action="store_true")
    a = ap.parse_args()
    img = cv2.imread(a.src, cv2.IMREAD_COLOR)
    if img.shape[1] / img.shape[0] > 1.9:  # equirect
        src = cv2.resize(img, (a.w, a.w // 2), interpolation=cv2.INTER_AREA)
    else:
        s = a.w / img.shape[1] if img.shape[1] > a.w else 1
        src = cv2.resize(img, (int(img.shape[1]*s), int(img.shape[0]*s)), interpolation=cv2.INTER_AREA)
    out = src if a.raw else grade(src, a.wb)
    cv2.imwrite(a.out + ".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, a.q, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
    sm = cv2.resize(out, (1024, int(1024 * out.shape[0] / out.shape[1])), interpolation=cv2.INTER_AREA)
    cv2.imwrite(a.out + "-sm.jpg", sm, [cv2.IMWRITE_JPEG_QUALITY, 80])
