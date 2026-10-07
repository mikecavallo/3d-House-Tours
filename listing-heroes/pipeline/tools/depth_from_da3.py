#!/usr/bin/env python3
"""Turn Depth Anything 3 raw depth (float EXR) + sky mask into the disparity PNG depthcam.js reads.

depthcam.js treats the map as disparity d in [0,1] (1 = nearest) with depth Z = 1/(NEAR + d*(1-NEAR)),
NEAR = 0.06, so d = 0 sits ~17x farther than d = 1. This maps 1/depth onto that scale:
  - robust range from the 1st/99th percentiles of non-sky pixels (the nearest pixel lands at 1.0),
  - sky pinned to 0,
  - edge-aware smoothing so siding and drywall don't ripple when the camera moves.

  python3 depth_from_da3.py front-depth.exr front-sky.png ../heroes/media/front-depth.png --like ../heroes/media/front.jpg
"""
import argparse, os, sys
os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2
import numpy as np

NEAR = 0.06


def read_exr(path):
    """Float EXR -> HxW float32. ComfyUI writes EXR through PyAV (ffmpeg), so PyAV reads it back; OpenCV is a
    fallback when it was built with OpenEXR."""
    try:
        import av
        with av.open(path) as c:
            frame = next(c.decode(video=0))
            arr = frame.to_ndarray(format="gbrpf32le")
            arr = arr[0] if arr.ndim == 3 and arr.shape[0] in (3, 4) else arr
            return np.ascontiguousarray(arr, dtype=np.float32)
    except ImportError:
        pass
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"could not read {path}: pip install av (or use OpenCV built with OpenEXR)")
    return img[..., 0] if img.ndim == 3 else img


def convert(depth, sky=None, guide=None, far_ratio=None):
    depth = depth.astype(np.float32)
    if depth.ndim == 3:
        depth = depth[..., 0]
    valid = np.isfinite(depth) & (depth > 0)
    if sky is not None:
        valid &= sky < 0.5
    if valid.sum() < 100:
        raise ValueError("depth map has no usable pixels")
    inv = np.zeros_like(depth)
    inv[valid] = 1.0 / depth[valid]
    lo, hi = np.percentile(inv[valid], [1, 99])
    # far end: the 1st-percentile point keeps its true distance relative to the nearest pixel, clamped to
    # what the engine can represent (Z ratio 1/NEAR); anything farther (and the sky) goes to 0
    ratio = far_ratio or min(hi / max(lo, 1e-9), 1 / NEAR)
    z = np.where(valid, hi / np.maximum(inv, 1e-9), 1 / NEAR)          # depth in units of the nearest pixel
    z = np.clip(z, 1.0, 1 / NEAR)
    d = (1.0 / z - NEAR) / (1 - NEAR)
    d[~valid] = 0.0
    if guide is not None:
        g = cv2.cvtColor(cv2.resize(guide, (d.shape[1], d.shape[0]), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        g = g.astype(np.float32) / 255
        try:
            d = cv2.ximgproc.guidedFilter(g, d.astype(np.float32), 4, 1e-3)
        except AttributeError:
            d = cv2.bilateralFilter(d.astype(np.float32), 7, 0.05, 5)
    return np.clip(d, 0, 1), ratio


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("depth_exr"); ap.add_argument("sky_png", nargs="?"); ap.add_argument("out_png")
    ap.add_argument("--like", help="the photo the map belongs to (sets size and edge-aware smoothing)")
    ap.add_argument("--width", type=int, default=960)
    a = ap.parse_args()
    depth = read_exr(a.depth_exr)
    sky = None
    if a.sky_png:
        s = cv2.imread(a.sky_png, cv2.IMREAD_GRAYSCALE)
        sky = cv2.resize(s, (depth.shape[1], depth.shape[0])).astype(np.float32) / 255
    guide = cv2.imread(a.like) if a.like else None
    H = round(a.width * (guide.shape[0] / guide.shape[1] if guide is not None else depth.shape[0] / depth.shape[1]))
    depth = cv2.resize(depth, (a.width, H), interpolation=cv2.INTER_AREA)
    if sky is not None:
        sky = cv2.resize(sky, (a.width, H), interpolation=cv2.INTER_AREA)
    d, ratio = convert(depth, sky, guide)
    os.makedirs(os.path.dirname(os.path.abspath(a.out_png)), exist_ok=True)
    cv2.imwrite(a.out_png, (d * 255 + 0.5).astype(np.uint8))
    print(f"{a.out_png}: {a.width}x{H}, depth range x{ratio:.1f}")


if __name__ == "__main__":
    main()
