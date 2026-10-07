"""Dusk masks for front2: R = sky, G = window glass and lamp (emissive), B = warm light spill."""
import cv2, numpy as np
W, H = 1024, 640
def P(pts): return np.array([[x/100*W, y/100*H] for x, y in pts], np.int32)
sky = cv2.resize(cv2.imread("maps/front2-sky.png", 0), (W, H), interpolation=cv2.INTER_LINEAR).astype(np.float32)/255
win = np.zeros((H, W), np.float32)
glass = {
  "door":  [(28.0,48.6),(30.0,48.3),(30.0,58.0),(28.0,58.2)],
  "bayL":  [(33.4,45.8),(35.0,45.4),(35.0,57.9),(33.4,58.2)],
  "bayC":  [(36.1,45.0),(40.9,43.4),(40.9,57.2),(36.1,57.7)],
  "bayR":  [(41.9,42.3),(44.1,41.6),(44.1,56.6),(41.9,57.0)],
  "side":  [(71.5,50.7),(72.2,50.9),(72.2,61.8),(71.5,61.8)],
  "attic": [(75.6,33.7),(76.05,33.6),(76.15,35.5),(75.9,37.4),(75.5,37.3),(75.45,35.3)],
}
for k, pts in glass.items(): cv2.fillPoly(win, [P(pts)], 1.0)
lamp = (31.44/100*W, 47.4/100*H)
cv2.circle(win, (int(lamp[0]), int(lamp[1])), 3, 1.0, -1)
win = cv2.GaussianBlur(win, (0, 0), 0.8)
# spill: windows bloom outward, the lamp throws a pool on the siding, the bay lights the shrub below it
spill = cv2.GaussianBlur(win, (0, 0), 14)*2.2 + cv2.GaussianBlur(win, (0, 0), 40)*2.5
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
r = np.hypot((xx - lamp[0])/1.0, (yy - lamp[1])/1.15)
spill += 0.95*np.exp(-(r/34)**2) + 0.35*np.exp(-(r/90)**2)
bay = np.zeros((H, W), np.float32); cv2.fillPoly(bay, [P([(33,58),(44.5,57),(47,78),(31,80)])], 1.0)
spill += cv2.GaussianBlur(bay, (0, 0), 22)*0.5
spill = np.clip(spill, 0, 1)
out = np.dstack([spill, win, sky])  # BGR order for cv2 -> stored as R=sky, G=win, B=spill
cv2.imwrite("maps/front2-mask.png", np.clip(out*255, 0, 255).astype(np.uint8))
prev = cv2.resize(cv2.imread("photos/front2.jpg"), (W, H))
vis = (prev*0.35 + np.dstack([spill*255, win*255, sky*255])*0.65).astype(np.uint8)
cv2.imwrite("prev/mask-front2.jpg", vis)
