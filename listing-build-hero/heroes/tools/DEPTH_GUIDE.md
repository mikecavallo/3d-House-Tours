# Authoring a depth spec for a listing photo

Working dir: /tmp/claude-0/-home-user-CAD-slides/10cdeea3-449c-50cf-8da2-30420cad9439/scratchpad/hero
Photos: photos/<name>.jpg (2400x1500, 16:10). Output map: maps/<name>-depth.png (disparity, 255 = nearest).

The web page flies a camera INTO the photo by raymarching this disparity map. Errors show up as
(a) smears where the camera sees past a depth step, (b) wavy/bent straight lines where depth is noisy
inside a flat surface, (c) things sliding the wrong way (a near object marked far or vice versa).

## Tools
- `python3 grid.py <name>` -> prev/grid-<name>.jpg: 1200x750 photo with a 5% grid, labels in percent.
  For precise outlines crop/zoom yourself with python+cv2 (see example below) using a 1% grid.
- `python3 depth.py --spec specs/<name>.json <name>` -> builds maps/<name>-depth.png and
  prev/depth-<name>.jpg (turbo colormap over the photo: red = near, blue = far, purple = sky, polygons outlined).
- `python3 move.py <name> <out.jpg> "x,y,z,lookU,lookV,lookD,zoom" [...]` -> CPU render from moved cameras
  (identical math to the page). x right, y up, z forward; photo camera is at 0,0,0. look = a point on
  the photo in percent across, percent down, and its disparity. View the output with the Read tool.

## Spec format (all coordinates are PERCENT of width / height, origin top-left)
```json
{ "horizon": 47.5,          // eye-level row in percent (where the floor/ground would meet infinity)
  "ceilK": 1.67,            // interiors: (camera height above floor)/(camera distance below ceiling), ~1.5/0.9
  "skyauto": "fixed", "skyMaxY": 60, "skyV": 0.78,   // optional: bright pixels inside layers flagged "sky": true become sky (d=0)
  "gr": 4,                  // edge-snap radius in px at 960x600 (3-6). Smaller = less rippling.
  "scale": 1.0,
  "layers": [ ...painted in order, later wins... ] }
```
Layer types:
- `{"type":"ground","poly":[[x,y],...]}` floor / lawn / deck boards. Disparity = (y - horizon)/(100 - horizon).
  Bottom row of the image = 1.0 (nearest). Ground must be BELOW the horizon.
- `{"type":"ceiling","poly":[...]}` interiors. Disparity = ceilK*(horizon - y)/(100 - horizon).
- `{"type":"vertical","poly":[...]}` (also the DEFAULT for unpainted pixels): walls, furniture, trees.
  Each pixel takes the disparity of the nearest ground pixel BELOW it in the same column (where it
  stands on the floor). Columns with no ground below use the bottom row (1.0). If a vertical pixel has a
  ceiling above it and would otherwise get 1.0, it takes the ceiling contact instead.
- `{"type":"fixed","d":0.3,"poly":[...]}` constant disparity (background tree masses, a far wall).
  Add `"sky": true` to let skyauto turn bright pixels inside it into sky.
- `{"type":"grad","p0":[x,y],"d0":0.9,"p1":[x,y],"d1":0.45,"poly":[...]}` linear ramp along p0->p1:
  use for walls seen at an angle (receding side walls), stairs, a sofa running into depth.
- `{"type":"sky","poly":[...]}` disparity 0.
- Any layer can add `"nosnap": true`: the edge-snap filter is switched off inside it, so thin repeated detail (railings, balusters, blinds) keeps straight lines.

Consistency: a wall that meets the floor at row y has disparity (y-h)/(100-h); a ceiling edge meeting the same
wall must give about the same value (that is what ceilK tunes: solve for the horizon/ceilK that make the
floor contact and ceiling contact of the far wall agree). Typical interior: horizon 45-52, ceilK 1.4-1.9.
A thing in front of a wall must be NEARER (larger d) than the wall. Doorways/openings into far rooms are
farther (smaller d) than the wall around them; paint the far room's floor as ground so its walls get contact.

Pitfalls learned on earlier photos:
- Never let skyauto touch house walls/white trim (only flag tree/sky layers with "sky": true) or windows punch holes.
- Big constant-vs-ramp jumps inside one flat surface bend its straight lines; keep a flat wall ONE layer.
- Foreground furniture touching the bottom edge gets 1.0 automatically; if it is actually a bit back, use fixed/grad.
- The camera moves mostly FORWARD toward the target given to you; get that path clean first.
- Smears at the image edge when the camera moves sideways are expected; don't fight them.

Examples: specs/front.json (exterior), specs/living.json (interior with ceiling and ramps),
specs/decktub.json, specs/back.json. Zoom helper:
```python
import cv2, numpy as np
im=cv2.imread("photos/NAME.jpg"); H,W=im.shape[:2]; x0,x1,y0,y1=.3,.6,.3,.6
c=im[int(y0*H):int(y1*H),int(x0*W):int(x1*W)]; c=cv2.resize(c,(1200,int(1200*(y1-y0)*H/((x1-x0)*W)))); h,w=c.shape[:2]
for p in range(101):
  X=p/100
  if x0<=X<=x1: xx=int((X-x0)/(x1-x0)*w); cv2.line(c,(xx,0),(xx,h),(0,255,255) if p%5==0 else (0,140,255),1); cv2.putText(c,str(p),(xx+2,12),0,.4,(255,255,255),1)
  if y0<=X<=y1: yy=int((X-y0)/(y1-y0)*h); cv2.line(c,(0,yy),(w,yy),(0,255,255) if p%5==0 else (0,140,255),1); cv2.putText(c,str(p),(2,yy-2),0,.4,(255,255,255),1)
cv2.imwrite("prev/zoom-NAME.jpg",c)
```
