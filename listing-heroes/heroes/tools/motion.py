"""Living-photo maps for the rear photo.
back-motion.png: R = sky, G = foliage sway weight (stronger toward treetops), B = curtain billow weight (stronger toward the hem).
back-clouds.jpg: the sky band with trees and house painted out, for drifting clouds."""
import cv2, numpy as np
src = cv2.imread("photos/back.jpg"); SH, SW = src.shape[:2]
W, H = 1024, 640
im = cv2.resize(src, (W, H), interpolation=cv2.INTER_AREA)
def P(pts): return np.array([[x/100*W, y/100*H] for x, y in pts], np.int32)
sky = cv2.resize(cv2.imread("maps/back-sky.png", 0), (W, H)).astype(np.float32)/255
hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV).astype(np.float32)
greenish = ((hsv[..., 0] > 25) & (hsv[..., 0] < 95) & (hsv[..., 1] > 40)).astype(np.float32)
pinkish = (((hsv[..., 0] < 12) | (hsv[..., 0] > 150)) & (hsv[..., 1] > 50)).astype(np.float32)
yy = np.mgrid[0:H, 0:W][0].astype(np.float32)/H*100
fol = np.zeros((H, W), np.float32)
for poly, base, span in [
    ([(0,8),(30,8),(30,46),(23.5,46),(10,46),(8,40),(0,40)], 72, 55),
    ([(0,38),(9.5,38),(9.5,72),(0,72)], 72, 30),
    ([(74,0),(100,0),(100,84),(74,84)], 82, 70)]:
    m = np.zeros((H, W), np.float32); cv2.fillPoly(m, [P(poly)], 1.0)
    w = np.clip((base - yy)/span, 0, 1)**0.8
    fol = np.maximum(fol, m*w)
fol *= np.clip(greenish + pinkish*0.9 + 0.25, 0, 1)
fol *= (1 - sky)
fol = cv2.GaussianBlur(fol, (0, 0), 2.0)
cur = np.zeros((H, W), np.float32)
cv2.fillPoly(cur, [P([(9.2,47.6),(32.5,47.3),(35.6,52.2),(32.6,52.6),(32.5,61.2),(26,61.6),(20,60.6),(15,60.9),(8.9,60.9)])], 1.0)
cur *= np.clip((yy - 47.5)/12.5, 0, 1)**1.2
cur = cv2.GaussianBlur(cur, (0, 0), 1.5)
out = np.dstack([cur, fol, sky])
cv2.imwrite("maps/back-motion.png", np.clip(out*255, 0, 255).astype(np.uint8))
# cloud plate: top 46% of the photo with non-sky painted out
band = int(SH*0.46)
skyF = cv2.resize(cv2.imread("maps/back-sky.png", 0), (SW, SH))[:band]
plate = src[:band].copy()
hole = (skyF < 200).astype(np.uint8)*255
hole = cv2.dilate(hole, np.ones((5, 5), np.uint8))
small = cv2.resize(plate, (SW//4, band//4), interpolation=cv2.INTER_AREA)
hs = cv2.resize(hole, (SW//4, band//4), interpolation=cv2.INTER_NEAREST)
fill = cv2.inpaint(small, hs, 9, cv2.INPAINT_TELEA)
fill = cv2.GaussianBlur(cv2.resize(fill, (SW, band), interpolation=cv2.INTER_CUBIC), (0, 0), 6)
mask3 = (cv2.GaussianBlur(hole, (0, 0), 3)/255.0)[..., None]
plate = (plate*(1 - mask3) + fill*mask3).astype(np.uint8)
plate = cv2.resize(plate, (2048, int(2048*band/SW)), interpolation=cv2.INTER_AREA)
cv2.imwrite("maps/back-clouds.jpg", plate, [cv2.IMWRITE_JPEG_QUALITY, 80])
vis = (im*0.4 + np.dstack([cur*255, fol*255, sky*255])*0.6).astype(np.uint8)
cv2.imwrite("prev/motion-back.jpg", np.vstack([vis, cv2.resize(plate, (W, int(W*plate.shape[0]/plate.shape[1])))]))
