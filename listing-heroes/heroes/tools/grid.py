import cv2, sys
for n in sys.argv[1:]:
    im = cv2.imread(f"photos/{n}.jpg"); im = cv2.resize(im, (1200, 750), interpolation=cv2.INTER_AREA)
    H, W = im.shape[:2]
    for i in range(1, 20):
        x = int(W*i/20); y = int(H*i/20)
        c = (0,255,255) if i % 2 == 0 else (0,160,255)
        th = 1
        cv2.line(im, (x,0), (x,H), c, th); cv2.line(im, (0,y), (W,y), c, th)
        if i % 2 == 0:
            cv2.putText(im, f"{i*5}", (x+2, 14), cv2.FONT_HERSHEY_SIMPLEX, .45, (0,0,0), 3); cv2.putText(im, f"{i*5}", (x+2, 14), cv2.FONT_HERSHEY_SIMPLEX, .45, (255,255,255), 1)
            cv2.putText(im, f"{i*5}", (2, y-3), cv2.FONT_HERSHEY_SIMPLEX, .45, (0,0,0), 3); cv2.putText(im, f"{i*5}", (2, y-3), cv2.FONT_HERSHEY_SIMPLEX, .45, (255,255,255), 1)
    cv2.imwrite(f"prev/grid-{n}.jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 85])
