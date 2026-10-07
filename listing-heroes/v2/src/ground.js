/* REAL.ground: procedural photoreal ground surfaces for the build (soil, crushed stone, bark mulch, lawn).
   REAL.ground.create(THREE, renderer, opts) -> {
     buildMs,
     variants: { soil, gravel, mulch, lawnBox },          box pieces with world-scaled UVs (core.worldUV)
     lawnMaterial(sizeFeet) -> MeshStandardMaterial      for ONE flat PlaneGeometry(sizeFeet, sizeFeet), plain 0..1 UVs
   }
   REAL.ground.grass(THREE, renderer, {areas:[{x0,x1,z0,z1}], density, height, seed, max, y}) -> InstancedMesh of 3D grass tufts

   How it is made (no images; deterministic seeds; canvas 2D + typed-array rasterising):
   - Detail maps come from a small JS scanline rasteriser that writes colour, tangent normal, height and roughness for
     every primitive at once, so the maps agree pixel for pixel: individual grass blades (leaning, V-folded, mower-cut
     or pointed), clover leaflets, shredded-bark strips with fibres and ragged ends, faceted crushed stones (every facet
     a plane with an analytic normal), flat-topped soil clods and partly buried stones.
     Texel density: lawn 0.07 in, soil 0.07 in, gravel and mulch 0.07 in (512px per 3 ft).
   - Each material gets a shader patch (groundPatch) that works in WORLD space:
       * every map is sampled twice (second copy rotated + rescaled) and the two are picked per pixel by HEIGHT plus a
         low-frequency world-noise bias, so the tile never repeats visibly and the switch is crisp (the taller blade,
         chip or stone wins) instead of a blurry cross-fade;
       * a 256px macro noise texture at four unrelated scales varies tone, hue and roughness;
       * lawn: clover patches whose plants appear one by one at the fringe (plant rank stored in the clover normal map's
         spare B channel), dry/yellow and lush/dark patches, view-dependent mowing stripes (fwidth anti-aliased so they
         never moire at distance), and a grazing-angle canopy fill (across a lawn you see blade sides, not the gaps);
       * soil: damp, darker, glossier patches.
   - Data maps: roughness texture R = height (0..1, drives the height blend), G = roughness (three reads .g).
   - Hot loops live in small monomorphic functions (V8 optimises them once instead of deopting a big generator). */
(function(){
"use strict";
const REAL = window.REAL = window.REAL || {};

/* ---------------------------------------------------------------- small helpers */
function sstep(a, b, x){ let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

/* scratch arrays reused between generators (cuts GC pauses): tmp(n, slot) */
const TMP = {};
function tmp(n, slot){ const k = n + ":" + slot; return TMP[k] || (TMP[k] = new Float32Array(n)); }

/* uniform white noise -0.5..0.5 (xorshift32), optionally into a given array */
function white(n, seed, out){
  const f = out || new Float32Array(n);
  let s = (Math.imul(seed | 0, 2654435761) | 0) || 1;
  for (let i = 0; i < n; i++){ s ^= s << 13; s ^= s >>> 17; s ^= s << 5; f[i] = (s >>> 0) / 4294967296 - 0.5; }
  return f;
}
/* 3x3 box blur in place (wrapping); t = scratch array of the same size */
function blur1(f, W, H, t){
  for (let y = 0; y < H; y++){
    const row = y * W;
    t[row] = (f[row + W - 1] + f[row] + f[row + 1]) * 0.3333333;
    for (let x = 1; x < W - 1; x++) t[row + x] = (f[row + x - 1] + f[row + x] + f[row + x + 1]) * 0.3333333;
    t[row + W - 1] = (f[row + W - 2] + f[row + W - 1] + f[row]) * 0.3333333;
  }
  for (let y = 0; y < H; y++){
    const r0 = (y === 0 ? H - 1 : y - 1) * W, r1 = y * W, r2 = (y === H - 1 ? 0 : y + 1) * W;
    for (let x = 0; x < W; x++) f[r1 + x] = (t[r0 + x] + t[r1 + x] + t[r2 + x]) * 0.3333333;
  }
  return f;
}
/* [1 2 1]/4 tent blur in place (wrapping); t = scratch */
function tent(f, W, H, t){
  for (let y = 0; y < H; y++){
    const row = y * W;
    for (let x = 0; x < W; x++){
      const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
      t[row + x] = (f[row + xl] + 2 * f[row + x] + f[row + xr]) * 0.25;
    }
  }
  for (let y = 0; y < H; y++){
    const r0 = (y === 0 ? H - 1 : y - 1) * W, r1 = y * W, r2 = (y === H - 1 ? 0 : y + 1) * W;
    for (let x = 0; x < W; x++) f[r1 + x] = (t[r0 + x] + 2 * t[r1 + x] + t[r2 + x]) * 0.25;
  }
  return f;
}
/* one octave of tileable value noise (gx x gy lattice, smoothstep weights) added into out, scaled by amp */
function octave(out, W, H, lat, gx, gy, amp){
  const xi0 = new Int32Array(W), xi1 = new Int32Array(W), xw = new Float32Array(W), row = new Float32Array(gx);
  for (let x = 0; x < W; x++){ const fx = x / W * gx, a = fx | 0, t = fx - a; xi0[x] = a; xi1[x] = a + 1 === gx ? 0 : a + 1; xw[x] = t * t * (3 - 2 * t); }
  for (let y = 0; y < H; y++){
    const fy = y / H * gy, y0 = fy | 0, t = fy - y0, wy = t * t * (3 - 2 * t), y1 = y0 + 1 === gy ? 0 : y0 + 1, r0 = y0 * gx, r1 = y1 * gx;
    for (let x = 0; x < gx; x++) row[x] = lat[r0 + x] + (lat[r1 + x] - lat[r0 + x]) * wy;
    const o = y * W;
    for (let x = 0; x < W; x++){ const a = row[xi0[x]]; out[o + x] += amp * (a + (row[xi1[x]] - a) * xw[x]); }
  }
}
/* fast tileable fbm, normalised to -0.5..0.5 */
function fbm(C, W, H, o){
  const oct = o.octaves || 4, base = o.base || 4, pers = o.persistence == null ? 0.5 : o.persistence, rnd = C.rng(o.seed || 1);
  const out = new Float32Array(W * H);
  let amp = 1;
  for (let k = 0; k < oct; k++){
    const gx = Math.min(W, base << k), gy = Math.min(H, base << k), lat = new Float32Array(gx * gy);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    octave(out, W, H, lat, gx, gy, amp);
    amp *= pers;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < out.length; i++){ const v = out[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const r = 1 / ((hi - lo) || 1);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * r - 0.5;
  return out;
}
/* low-res fbm (lw x lh) upsampled bilinearly (wrapping) to W x H; values -0.5..0.5 */
function field(C, W, H, lw, lh, o, outArr){
  const f = fbm(C, lw, lh, o);
  if (lw === W && lh === H) return f;
  const out = outArr || new Float32Array(W * H);
  const xi0 = new Int32Array(W), xi1 = new Int32Array(W), xt = new Float32Array(W), row = new Float32Array(lw);
  for (let x = 0; x < W; x++){ let fx = (x + 0.5) / W * lw - 0.5; if (fx < 0) fx += lw; const a = fx | 0; xi0[x] = a; xi1[x] = a + 1 === lw ? 0 : a + 1; xt[x] = fx - a; }
  for (let y = 0; y < H; y++){
    let fy = (y + 0.5) / H * lh - 0.5; if (fy < 0) fy += lh;
    const y0 = fy | 0, y1 = y0 + 1 === lh ? 0 : y0 + 1, ty = fy - y0, r0 = y0 * lw, r1 = y1 * lw;
    for (let x = 0; x < lw; x++) row[x] = f[r0 + x] + (f[r1 + x] - f[r0 + x]) * ty;
    const o2 = y * W;
    for (let x = 0; x < W; x++){ const a = row[xi0[x]]; out[o2 + x] = a + (row[xi1[x]] - a) * xt[x]; }
  }
  return out;
}
/* smooth periodic 1D noise table (len 1024, -1..1) for fibres and ragged edges */
function table(seed){
  const n = 1024, f = white(n, seed), g = new Float32Array(n);
  for (let p = 0; p < 2; p++){
    for (let i = 0; i < n; i++){ let s = 0; for (let k = -3; k <= 3; k++) s += f[(i + k + n) & (n - 1)]; g[i] = s / 7; }
    f.set(g);
  }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(f[i]));
  for (let i = 0; i < n; i++) f[i] /= m;
  return f;
}

/* raster buffers: colour in sRGB 0..255, normal xy in CANVAS coords (x right, y down), height, roughness 0..1.
   Pooled per size: every generator initialises every channel it uses in its base pass. */
const POOL = {};
function buffers(n){
  if (!POOL[n]) POOL[n] = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n),
           nx: new Float32Array(n), ny: new Float32Array(n), h: new Float32Array(n), ro: new Float32Array(n) };
  return POOL[n];
}

/* ---------------------------------------------------------------- canvases */
function rgbCanvas(C, W, H, B){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  const R = B.r, G = B.g, Bb = B.b;
  for (let i = 0, k = 0; i < W * H; i++, k += 4){ d[k] = R[i]; d[k+1] = G[i]; d[k+2] = Bb[i]; d[k+3] = 255; }   /* Uint8Clamped clamps */
  ctx.putImageData(img, 0, 0);
  return c;
}
/* normal map from explicit normals (canvas coords); OpenGL convention, canvas up = +V. bch: optional B channel data (0..1) */
function nrmCanvas(C, W, H, B, bch){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  const NX = B.nx, NY = B.ny;
  for (let i = 0, k = 0; i < W * H; i++, k += 4){
    let x = NX[i], y = NY[i], q = x * x + y * y;
    if (q > 0.92){ const s = Math.sqrt(0.92 / q); x *= s; y *= s; q = 0.92; }
    d[k] = (x * 0.5 + 0.5) * 255; d[k+1] = (-y * 0.5 + 0.5) * 255;
    d[k+2] = bch ? bch[i] * 255 : (Math.sqrt(1 - q) * 0.5 + 0.5) * 255; d[k+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
/* normal map from a height field in INCHES (pixel = pu inches), slope gain k */
function heightNrmCanvas(C, W, H, hf, pu, k){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  const s = k / (2 * pu);
  for (let y = 0; y < H; y++){
    const ru = ((y - 1 + H) % H) * W, rd = ((y + 1) % H) * W, row = y * W;
    for (let x = 0; x < W; x++){
      const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
      const nx = -(hf[row + xr] - hf[row + xl]) * s, ny = (hf[rd + x] - hf[ru + x]) * s;   /* -dh/dv, +V = canvas up */
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), k4 = (row + x) * 4;
      d[k4] = (nx * inv * 0.5 + 0.5) * 255; d[k4+1] = (ny * inv * 0.5 + 0.5) * 255; d[k4+2] = (inv * 0.5 + 0.5) * 255; d[k4+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
/* data map: R = height (0..1 over hlo..hhi), G = roughness, B = 0 */
function dataCanvas(C, W, H, hgt, ro, hlo, hhi){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  const hr = 255 / ((hhi - hlo) || 1);
  for (let i = 0, k = 0; i < W * H; i++, k += 4){ d[k] = (hgt[i] - hlo) * hr; d[k+1] = ro[i] * 255; d[k+2] = 0; d[k+3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ================================================================ LAWN
   512px = 3 ft (0.07 in/px). Blades are drawn bottom layer first, darker with depth. */
const LAWN_FT = 3;
/* summer cool-season lawn (Kentucky blue / rye / fescue mix) as photographed in Connecticut: clearly yellow-green,
   blue channel well under half of green */
const LAWN_PAL = [
  [138, 162, 24],   /* sunny yellow-green */
  [120, 150, 23],
  [105, 138, 22],   /* mid green */
  [92, 126, 22],
  [83, 118, 27],    /* deep green */
  [129, 154, 27],
  [146, 160, 31]    /* pale */
];
/* rasterise one leaning grass blade. Base (bx,by), unit direction (dx,dy), projected length L px, base width w px,
   curv = sideways bend, blunt = mower-cut tip. BL holds colours (base->tip) and the two V-fold half normals. */
const BL = { c0: [0,0,0], c1: [0,0,0], nL: [0,0], nR: [0,0] };
function blade(B, W, H, bx, by, dx, dy, L, w, curv, blunt, z0, z1, ro){
  const hl = L * 0.5, cx = bx + dx * hl, cy = by + dy * hl;
  const hwm = w * 0.5 + Math.abs(curv) * L + 1, A = hl + 1;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const ex = ax * A + ay * hwm, ey = ay * A + ax * hwm;
  const y0 = Math.floor(cy - ey), y1 = Math.ceil(cy + ey);
  const iL = 1 / L, hw0 = w * 0.5, tp = blunt ? 0.3 : 1.0;
  const Rr = B.r, Rg = B.g, Rb = B.b, Nx = B.nx, Ny = B.ny, Hh = B.h, Ro = B.ro;
  const c0 = BL.c0, c1 = BL.c1;
  const c0r = c0[0], c0g = c0[1], c0b = c0[2], dr = c1[0] - c0r, dg = c1[1] - c0g, db = c1[2] - c0b;
  const nLx = BL.nL[0], nLy = BL.nL[1], nRx = BL.nR[0], nRy = BL.nR[1], dz = z1 - z0;
  for (let y = y0; y <= y1; y++){
    const py = y + 0.5 - cy;
    let lo = -ex - 1, hi = ex + 1;
    if (ax > 1e-4){ let a = (-A - py * dy) / dx, b = (A - py * dy) / dx; if (a > b){ const t = a; a = b; b = t; } if (a > lo) lo = a; if (b < hi) hi = b; }
    if (ay > 1e-4){ let a = (py * dx - hwm) / dy, b = (py * dx + hwm) / dy; if (a > b){ const t = a; a = b; b = t; } if (a > lo) lo = a; if (b < hi) hi = b; }
    if (lo > hi) continue;
    const xa = Math.ceil(cx + lo - 0.5), xb = Math.floor(cx + hi - 0.5), row = (y < 0 ? y + H : y >= H ? y - H : y) * W;
    for (let x = xa; x <= xb; x++){
      const qx = x + 0.5 - cx;
      const u = qx * dx + py * dy + hl, v = -qx * dy + py * dx;
      if (u < -0.5 || u > L + 0.5) continue;
      const t = u < 0 ? 0 : u > L ? 1 : u * iL;
      const vc = v - curv * u * t;
      /* blunt (cut) blades taper 30%, pointed ones taper to nothing (t^2 approximates t^1.5 well enough) */
      const hw = hw0 * (1 - tp * (blunt ? t : t * t));
      const av = vc < 0 ? -vc : vc;
      let cov = hw - av + 0.5; if (cov <= 0) continue; if (cov > 1) cov = 1;
      const e0 = u + 0.5, e1 = L - u + 0.5;
      if (e0 < 1) cov *= e0; if (e1 < 1) cov *= e1;
      const i = row + (x < 0 ? x + W : x >= W ? x - W : x);
      /* V-fold halves + faint lighter midrib, both with a 1 px ramp so magnified blades have no sawtooth midline */
      let tL = vc + 0.5; tL = tL < 0 ? 0 : tL > 1 ? 1 : tL;
      let mr = 0.45 * hw - av + 0.5; mr = mr < 0 ? 0 : mr > 1 ? 1 : mr;
      const k = (0.93 + 0.14 * tL) * (1 + 0.04 * mr);
      Rr[i] += ((c0r + dr * t) * k - Rr[i]) * cov;
      Rg[i] += ((c0g + dg * t) * k - Rg[i]) * cov;
      Rb[i] += ((c0b + db * t) * k - Rb[i]) * cov;
      const bnx = nRx + (nLx - nRx) * tL, bny = nRy + (nLy - nRy) * tL;
      Nx[i] += (bnx - Nx[i]) * cov; Ny[i] += (bny - Ny[i]) * cov;
      Hh[i] += (z0 + dz * t - Hh[i]) * cov;
      Ro[i] += (ro - Ro[i]) * cov;
    }
  }
}
/* one blade with random parameters; px = inches per pixel; z = canopy depth 0 (bottom) .. 1 (top) */
function grassBlade(B, W, H, rnd, px, z, pal, o){
  const ang = rnd() * 6.2831853, dx = Math.cos(ang), dy = Math.sin(ang);
  const sinT = o.lean0 + o.lean1 * rnd(), cosT = Math.sqrt(1 - sinT * sinT);
  const len3 = (o.len0 + o.len1 * Math.pow(rnd(), 1.4)) / px;
  const L = Math.max(2, len3 * sinT);
  const w = (o.w0 + o.w1 * rnd()) / px;
  const curv = (rnd() - 0.5) * 0.3;
  const blunt = rnd() < o.cut;
  let r, g, b;
  if (rnd() < o.dead){ r = 136 + rnd() * 20; g = 128 + rnd() * 16; b = 78 + rnd() * 14; }
  else { const p = pal[(rnd() * pal.length) | 0], j = 0.9 + rnd() * 0.2, jh = (rnd() - 0.5) * 0.12; r = p[0] * j * (1 + jh); g = p[1] * j; b = p[2] * j * (1 - jh); }
  const sh = o.sh0 + o.sh1 * Math.pow(z, 0.9);
  BL.c0[0] = r * sh * 0.72; BL.c0[1] = g * sh * 0.74; BL.c0[2] = b * sh * 0.72;
  BL.c1[0] = r * sh; BL.c1[1] = g * sh; BL.c1[2] = b * sh;
  if (blunt && rnd() < o.frayed){ BL.c1[0] = BL.c1[0] * 0.75 + 34 * sh; BL.c1[1] = BL.c1[1] * 0.8 + 30 * sh; BL.c1[2] = BL.c1[2] * 0.75 + 18 * sh; }
  /* blade face normal (-d cos, sin) plus a sideways V-fold, canvas coords */
  const f = o.fold, pxv = -dy, pyv = dx;
  let ax = -dx * cosT + pxv * f, ay = -dy * cosT + pyv * f, az = sinT, il = 1 / Math.sqrt(ax * ax + ay * ay + az * az);
  BL.nL[0] = ax * il; BL.nL[1] = ay * il;
  ax = -dx * cosT - pxv * f; ay = -dy * cosT - pyv * f; il = 1 / Math.sqrt(ax * ax + ay * ay + az * az);
  BL.nR[0] = ax * il; BL.nR[1] = ay * il;
  blade(B, W, H, rnd() * W, rnd() * H, dx, dy, L, w, curv, blunt, z - 0.12, z, o.ro0 + o.ro1 * rnd());
}
/* under the canopy: dark thatch / soil */
function thatchPass(B, n, f1, wn, lo, hi){
  const R = B.r, G = B.g, Bb = B.b, NX = B.nx, NY = B.ny, Hh = B.h, Ro = B.ro;
  for (let i = 0; i < n; i++){
    let t = 0.5 + f1[i] * 0.8 + wn[i] * 2.4; t = t < 0 ? 0 : t > 1 ? 1 : t;
    R[i] = lo[0] + (hi[0] - lo[0]) * t; G[i] = lo[1] + (hi[1] - lo[1]) * t; Bb[i] = lo[2] + (hi[2] - lo[2]) * t;
    NX[i] = wn[i] * 0.6; NY[i] = f1[i] * 0.2; Hh[i] = 0; Ro[i] = 0.95;
  }
}
const LAWN_O = { lean0: 0.32, lean1: 0.6, len0: 0.7, len1: 1.6, w0: 0.13, w1: 0.17, cut: 0.72, frayed: 0.3, dead: 0.012,
                 sh0: 0.46, sh1: 0.6, fold: 0.38, ro0: 0.52, ro1: 0.18 };

/* separable box blur with wrap-around (running sums, cost independent of radius): src -> dst, t = scratch */
function boxBlurWrap(src, dst, t, W, H, r){
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++){
    const o = y * W;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[o + ((k % W) + W) % W];
    for (let x = 0; x < W; x++){
      t[o + x] = s * inv;
      s += src[o + (x + r + 1) % W] - src[o + ((x - r) % W + W) % W];
    }
  }
  for (let x = 0; x < W; x++){
    let s = 0;
    for (let k = -r; k <= r; k++) s += t[(((k % H) + H) % H) * W + x];
    for (let y = 0; y < H; y++){
      dst[y * W + x] = s * inv;
      s += t[((y + r + 1) % H) * W + x] - t[(((y - r) % H + H) % H) * W + x];
    }
  }
  return dst;
}
/* three box passes ~ gaussian of the given sigma (px) */
function gaussWrap(src, dst, t, W, H, sigma){
  const r = Math.max(1, Math.round(Math.sqrt(sigma * sigma * 4 / 3 + 0.25) - 0.5));   /* 3 passes of width 2r+1 */
  boxBlurWrap(src, dst, t, W, H, r); boxBlurWrap(dst, dst, t, W, H, r); boxBlurWrap(dst, dst, t, W, H, r);
  return dst;
}
/* Flatten everything coarser than ~sigma: colour by ratio to the local mean (keeps dark gaps dark), roughness by
   difference. A tile then carries no blotches that could repeat as a lattice; the shader's macro layer adds the
   large-scale variation instead. */
function highPass(B, W, H, sigma){
  const n = W * H, bl = tmp(n, 6), t = tmp(n, 7);
  for (const ch of [B.r, B.g, B.b]){
    let mean = 0; for (let i = 0; i < n; i++) mean += ch[i]; mean /= n;
    gaussWrap(ch, bl, t, W, H, sigma);
    for (let i = 0; i < n; i++){ let q = mean / Math.max(1, bl[i]); q = q < 0.6 ? 0.6 : q > 1.6 ? 1.6 : q; ch[i] *= q; }
  }
  const ro = B.ro; let mr = 0; for (let i = 0; i < n; i++) mr += ro[i]; mr /= n;
  gaussWrap(ro, bl, t, W, H, sigma);
  for (let i = 0; i < n; i++) ro[i] += mr - bl[i];
}
function makeLawn(C, N, seed){
  const W = N, H = N, n = W * H, px = LAWN_FT * 12 / N, B = buffers(n), rnd = C.rng(seed);
  thatchPass(B, n, field(C, W, H, 64, 64, {octaves: 4, base: 4, seed: seed + 1}, tmp(n, 0)), blur1(white(n, seed + 7, tmp(n, 1)), W, H, tmp(n, 2)), [26, 30, 10], [56, 56, 20]);
  const layers = 8, total = 14000;     /* per 3 ft tile */
  for (let k = 0; k < layers; k++){
    const cnt = Math.round(total / layers);
    for (let j = 0; j < cnt; j++) grassBlade(B, W, H, rnd, px, (k + rnd()) / layers, LAWN_PAL, LAWN_O);
  }
  highPass(B, W, H, 0.4 * 12 / px);     /* sigma 0.4 ft */
  return { W, H, B };
}

/* clover / broadleaf plants drawn ONTO the finished lawn buffers (same tile, same UVs): where no plant is drawn the
   clover texture equals the lawn. Each plant writes a random rank (0..1; 0 = no leaf) into h; the shader compares it
   with the local patch density so whole plants appear one by one at a patch fringe. */
function makeCloverOnto(C, lawn, seed){
  const W = lawn.W, H = lawn.H, B = lawn.B, px = LAWN_FT * 12 / W, rnd = C.rng(seed);
  B.h.fill(0);
  const plants = 2800, lLayers = 6;    /* per 3 ft tile */
  const leafPal = [[112, 138, 34], [103, 131, 33], [95, 124, 36], [118, 141, 38], [88, 116, 34]];
  for (let k = 0; k < lLayers; k++){
    for (let j = 0; j < plants / lLayers; j++){
      const z = 0.45 + 0.55 * (k + rnd()) / lLayers, rank = 0.03 + 0.97 * rnd();
      const cx = rnd() * W, cy = rnd() * H, a = (0.22 + 0.15 * rnd()) / px, phi = rnd() * 6.283;
      const p = leafPal[(rnd() * leafPal.length) | 0], sh = 0.55 + 0.4 * z, j2 = 0.9 + 0.2 * rnd();
      const tilt = (rnd() - 0.5) * 0.5, tx = Math.cos(phi + 1.3) * tilt, ty = Math.sin(phi + 1.3) * tilt;
      for (let l = 0; l < 3; l++){
        const an = phi + l * 2.0944 + (rnd() - 0.5) * 0.4, dx = Math.cos(an), dy = Math.sin(an);
        const aa = a * (0.85 + 0.3 * rnd());
        leaflet(B, W, H, cx + dx * aa * 0.95, cy + dy * aa * 0.95, dx, dy, aa, aa * 0.82, p[0] * sh * j2, p[1] * sh * j2, p[2] * sh * j2, rank, tx, ty);
      }
    }
  }
  return lawn;
}
/* one obovate leaflet with a pale chevron; slightly cupped; writes rank into h */
function leaflet(B, W, H, cx, cy, dx, dy, a, b, cr, cg, cb, rank, tx, ty){
  const R = Math.ceil(a + 1), Rr = B.r, Rg = B.g, Rb = B.b, Nx = B.nx, Ny = B.ny, Hh = B.h, Ro = B.ro;
  const ia = 1 / a, ib = 1 / b;
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++){
    const py = y + 0.5 - cy, row = (y < 0 ? y + H : y >= H ? y - H : y) * W;
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++){
      const qx = x + 0.5 - cx, u = (qx * dx + py * dy) * ia, v = (-qx * dy + py * dx) * ib;
      /* obovate: wider toward the outer end (u>0), notched at the tip */
      const wv = v / (0.8 + 0.25 * u), av = v < 0 ? -v : v;
      const d = Math.sqrt(u * u + wv * wv) + (u > 0.6 && av < 0.2 ? 0.18 - av * 0.9 : 0);
      let cov = (1 - d) * a + 0.5; if (cov <= 0) continue; if (cov > 1) cov = 1;
      const i = row + (x < 0 ? x + W : x >= W ? x - W : x);
      const chev = Math.abs(av - (0.25 + u * 0.45));
      const k = (chev < 0.09 && u > -0.4 && u < 0.6 ? 1.22 : 1) * (0.9 + 0.06 * (u + 1));
      Rr[i] += (cr * k - Rr[i]) * cov; Rg[i] += (cg * k - Rg[i]) * cov; Rb[i] += (cb * k - Rb[i]) * cov;
      const nx = tx + (dx * u * 0.3 - dy * v * 0.25) * 0.8, ny = ty + (dy * u * 0.3 + dx * v * 0.25) * 0.8;
      Nx[i] += (nx - Nx[i]) * cov; Ny[i] += (ny - Ny[i]) * cov;
      if (cov > 0.5) Hh[i] = rank;
      Ro[i] += (0.48 - Ro[i]) * cov;
    }
  }
}

/* ================================================================ SOIL
   1024px = 6 ft (0.07 in/px). Connecticut glacial till as dug: warm yellowish-brown silty sand (about 10YR 4/4 to
   5/4) with faint darker organic mottles, crumbs, flat-topped tilted clods and sub-angular stones (grey schist and
   gneiss, rusty weathered rock) that are mostly coated in soil and sit IN the soil (no halos, no fillets). */
const SOIL_FT = 6;
function soilBase(B, W, H, tone, hue, lumpH, mid, wn, wn2, lump, hr, hg, hb){
  const W2 = W >> 1, H2 = H >> 1, R = B.r, G = B.g, Bb = B.b, Hh = B.h, Ro = B.ro;
  /* half-res base colour: warm brown, a slight yellow/grey drift, faint darker organic mottles */
  for (let i2 = 0; i2 < W2 * H2; i2++){
    let hh = 0.5 + hue[i2] * 1.1; hh = hh < 0 ? 0 : hh > 1 ? 1 : hh;
    const dk = 0.58 + 0.42 * sstep(-0.42, 0.12, tone[i2]);
    const r = 121 - 6 * hh, g = 95 - 1 * hh, b = 69 + 5 * hh;
    hr[i2] = 70 + (r - 70) * dk; hg[i2] = 55 + (g - 55) * dk; hb[i2] = 41 + (b - 41) * dk;
  }
  for (let y = 0; y < H; y++){
    const rowh = (y >> 1) * W2;
    for (let x = 0; x < W; x++){
      const i = y * W + x, i2 = rowh + (x >> 1);
      const gr = 1 + wn[i] * 0.45 + wn2[i] * 0.08 + mid[i] * 0.12;
      R[i] = hr[i2] * gr; G[i] = hg[i2] * gr; Bb[i] = hb[i2] * gr;
      lump[i] = lumpH[i2] * 0.35 + mid[i] * 0.12;          /* base relief in inches (the bed) */
      Hh[i] = lump[i] + wn[i] * 0.07 + wn2[i] * 0.015;
      Ro[i] = 0.93 + wn[i] * 0.1;
    }
  }
}
/* soft crumb / small ped: rounded lump with a noisy outline, a touch lighter (dry) on top */
function crumb(B, W, H, lump, wn, cx, cy, r, amp, lift){
  const R = Math.ceil(r * 1.3 + 1), Rr = B.r, Rg = B.g, Rb = B.b, Hh = B.h, ir2 = 1 / (r * r);
  for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++){
    const py = y + 0.5 - cy, row = (y < 0 ? y + H : y >= H ? y - H : y) * W;
    for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++){
      const qx = x + 0.5 - cx, i = row + (x < 0 ? x + W : x >= W ? x - W : x);
      const d2 = (qx * qx + py * py) * ir2 + wn[i] * 0.9;
      if (d2 >= 1) continue;
      const e = 1 - d2, top = lump[i] + amp * e * Math.sqrt(e);
      if (top > Hh[i]){ Hh[i] = top; const k = 1 + lift * e; Rr[i] *= k; Rg[i] *= k; Rb[i] *= k; }
    }
  }
}
/* angular clod: convex polygon whose facets are planes rising from each edge to a blunt crest (no step at the rim) */
function clodPoly(B, W, H, lump, wn, nv, cap, bx0, bx1, by0, by1, lift){
  const enx = ST.enx, eny = ST.eny, es = ST.es, ec = ST.ec, fsh = ST.fsh;
  const Rr = B.r, Rg = B.g, Rb = B.b, Hh = B.h, Ro = B.ro;
  for (let y = Math.floor(by0); y <= Math.ceil(by1); y++){
    const py = y + 0.5, row = (y < 0 ? y + H : y >= H ? y - H : y) * W;
    for (let x = Math.floor(bx0); x <= Math.ceil(bx1); x++){
      const qx = x + 0.5;
      let hmin = 1e9, fi = -1;
      for (let v = 0; v < nv; v++){
        const d = qx * enx[v] + py * eny[v] + ec[v];
        if (d < 0){ fi = -2; break; }
        const hh = d * es[v];
        if (hh < hmin){ hmin = hh; fi = v; }
      }
      if (fi < 0) continue;
      const i = row + (x < 0 ? x + W : x >= W ? x - W : x);
      let fs = fsh[fi];
      if (hmin > cap){ hmin = cap; fs = fsh[nv]; }
      const top = lump[i] + hmin + wn[i] * 0.08;
      if (top > Hh[i]){
        Hh[i] = top;
        const k = fs * (1 + lift * hmin / cap);
        Rr[i] *= k; Rg[i] *= k; Rb[i] *= k; Ro[i] = 0.97;
      }
    }
  }
}
/* sub-angular stone: convex polygon of planar facets (crisp, 1 px anti-aliased outline), partly buried, and coated in
   soil over most of its area (coating is thinnest on the crest); matte */
function soilStone(B, W, H, lump, mid, wn, nv, cap, bury, coat, sr, sg, sb, bx0, bx1, by0, by1){
  const enx = ST.enx, eny = ST.eny, es = ST.es, ec = ST.ec, fsh = ST.fsh;
  const Rr = B.r, Rg = B.g, Rb = B.b, Hh = B.h, Ro = B.ro;
  for (let y = Math.floor(by0); y <= Math.ceil(by1); y++){
    const py = y + 0.5, row = (y < 0 ? y + H : y >= H ? y - H : y) * W;
    for (let x = Math.floor(bx0); x <= Math.ceil(bx1); x++){
      const qx = x + 0.5;
      let hmin = 1e9, fi = -1, dmin = 1e9;
      for (let v = 0; v < nv; v++){
        const d = qx * enx[v] + py * eny[v] + ec[v];
        if (d < -0.5){ fi = -2; break; }
        if (d < dmin) dmin = d;
        const hh = d * es[v];
        if (hh < hmin){ hmin = hh; fi = v; }
      }
      if (fi < 0) continue;
      let cov = dmin + 0.5; if (cov > 1) cov = 1;
      const i = row + (x < 0 ? x + W : x >= W ? x - W : x);
      let fs = fsh[fi];
      if (hmin < 0) hmin = 0;
      if (hmin > cap){ hmin = cap; fs = fsh[nv]; }
      const top = lump[i] + hmin - bury;
      if (top <= Hh[i]) continue;          /* soil lies over the buried edge: ragged, natural outline */
      let m = coat + mid[i] * 2.2 + wn[i] * 1.6 - 0.4 * hmin / cap; m = m < 0 ? 0 : m > 1 ? 1 : m;
      const a = cov * (1 - m), q = fs * (1 + wn[i] * 0.35);
      Rr[i] += (sr * q - Rr[i]) * a; Rg[i] += (sg * q - Rg[i]) * a; Rb[i] += (sb * q - Rb[i]) * a;
      Hh[i] += (top - Hh[i]) * cov;
      Ro[i] += (0.85 + 0.07 * m - Ro[i]) * cov;
    }
  }
}
/* random convex polygon into ST (vx, vy, edge planes rising to a crest of height pkh); false if degenerate */
function polyST(rnd, cx, cy, r, nv, elong, jit, pkh, fsh0, fsh1){
  const vx = ST.vx, vy = ST.vy, enx = ST.enx, eny = ST.eny, es = ST.es, ec = ST.ec, fsh = ST.fsh;
  const a0 = rnd() * 6.283, ea = rnd() * 3.1416, eca = Math.cos(ea), esa = Math.sin(ea);
  for (let v = 0; v < nv; v++){
    const an = a0 + (v + (rnd() - 0.5) * jit) * 6.2832 / nv, rr = r * (0.7 + 0.45 * rnd());
    const lx = Math.cos(an) * rr, ly = Math.sin(an) * rr * elong;
    vx[v] = cx + lx * eca - ly * esa; vy[v] = cy + lx * esa + ly * eca;
  }
  const pkx = cx + (rnd() - 0.5) * r * 0.5, pky = cy + (rnd() - 0.5) * r * 0.5;
  for (let v = 0; v < nv; v++){
    const w2 = (v + 1) % nv, ex = vx[w2] - vx[v], ey = vy[w2] - vy[v], el = Math.sqrt(ex * ex + ey * ey) || 1;
    let nx = -ey / el, ny = ex / el, dp = (pkx - vx[v]) * nx + (pky - vy[v]) * ny;
    if (dp < 0){ nx = -nx; ny = -ny; dp = -dp; }
    if (dp < 0.5) return false;
    enx[v] = nx; eny[v] = ny; es[v] = pkh / dp; ec[v] = -(vx[v] * nx + vy[v] * ny); fsh[v] = fsh0 + fsh1 * rnd();
  }
  let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
  for (let v = 0; v < nv; v++){ if (vx[v] < bx0) bx0 = vx[v]; if (vx[v] > bx1) bx1 = vx[v]; if (vy[v] < by0) by0 = vy[v]; if (vy[v] > by1) by1 = vy[v]; }
  ST.bb[0] = bx0 - 1; ST.bb[1] = bx1 + 1; ST.bb[2] = by0 - 1; ST.bb[3] = by1 + 1;
  return true;
}
function makeSoil(C, N, seed){
  const W = N, H = N, n = W * H, pu = SOIL_FT * 12 / N, rnd = C.rng(seed);
  const B = buffers(n);
  /* smooth fields at half resolution (looked up with x>>1, y>>1), detail fields at full resolution */
  const W2 = W >> 1, H2 = H >> 1;
  const n2 = W2 * H2;
  const tone = field(C, W2, H2, 32, 32, {octaves: 4, base: 3, seed: seed + 1}, tmp(n2, 0));
  const hue = field(C, W2, H2, 32, 32, {octaves: 3, base: 3, seed: seed + 2}, tmp(n2, 1));
  const lumpH = field(C, W2, H2, 64, 64, {octaves: 4, base: 5, seed: seed + 6}, tmp(n2, 2));
  const mid = field(C, W, H, 128, 128, {octaves: 4, base: 12, seed: seed + 3}, tmp(n, 0));
  const wn2 = white(n, seed + 5, tmp(n, 1)), wn = tmp(n, 2);
  wn.set(wn2); blur1(wn, W, H, tmp(n, 3));
  const lump = tmp(n, 3);
  soilBase(B, W, H, tone, hue, lumpH, mid, wn, wn2, lump, tmp(n2, 3), tmp(n2, 4), tmp(n2, 5));
  /* crumbs and small peds (0.1-0.45 in) */
  const ncr = 6000;
  for (let c = 0; c < ncr; c++){
    const rIn = 0.06 + 0.34 * Math.pow(rnd(), 2.2), r = rIn / pu;
    crumb(B, W, H, lump, wn, rnd() * W, rnd() * H, r * (0.8 + 0.4 * rnd()), rIn * (0.08 + 0.22 * rnd()), 0.01 + 0.04 * rnd());
  }
  /* angular clods (0.5-3.5 in): the lumps that give dug ground its shape at 10-20 ft */
  const bb = ST.bb, ncl = 380;
  for (let c = 0; c < ncl; c++){
    const rIn = 0.5 + 3.0 * Math.pow(rnd(), 2.4), r = rIn / pu, nv = 7 + ((rnd() * 4) | 0);
    if (!polyST(rnd, rnd() * W, rnd() * H, r, nv, 0.6 + 0.4 * rnd(), 0.8, rIn * (0.1 + 0.1 * rnd()), 0.95, 0.07)) continue;
    const pkh = rIn * 0.15;
    ST.fsh[nv] = 1.02 + 0.06 * rnd();
    clodPoly(B, W, H, lump, wn, nv, pkh * (0.55 + 0.3 * rnd()), bb[0], bb[1], bb[2], bb[3], 0.04 + 0.05 * rnd());
  }
  /* stones: grit to small cobbles, sub-angular, mostly soil-coated */
  const stonePal = [[96, 93, 88], [80, 79, 77], [114, 90, 66], [132, 126, 118], [92, 94, 86], [104, 96, 86], [72, 68, 62], [120, 102, 82]];
  const nst = 720;
  for (let s = 0; s < nst; s++){
    const big = rnd();
    const rIn = big < 0.88 ? 0.07 + 0.17 * rnd() : big < 0.985 ? 0.3 + 0.6 * rnd() : 1.0 + 1.3 * rnd();
    const r = rIn / pu, nv = 5 + ((rnd() * 3) | 0), pkh = rIn * (0.4 + 0.3 * rnd());
    if (!polyST(rnd, rnd() * W, rnd() * H, r, nv, 0.6 + 0.4 * rnd(), 0.7, pkh, 0.8, 0.32)) continue;
    ST.fsh[nv] = 1.0 + 0.1 * rnd();
    const p = stonePal[(rnd() * stonePal.length) | 0], j = 0.86 + 0.26 * rnd();
    soilStone(B, W, H, lump, mid, wn, nv, pkh * (0.6 + 0.3 * rnd()), pkh * (0.15 + 0.35 * rnd()), 0.5 + 0.4 * rnd(),
              p[0] * j, p[1] * j, p[2] * j, bb[0], bb[1], bb[2], bb[3]);
  }
  /* sparse specks: mica / sand grains (light) and organic bits (dark) */
  const nsp = 4000, Rr = B.r, Rg = B.g, Rb = B.b, Hh = B.h;
  for (let k2 = 0; k2 < nsp; k2++){
    const x = (rnd() * W) | 0, y = (rnd() * H) | 0, i = y * W + x, k = rnd() < 0.5 ? 0.84 : 1.16;
    Rr[i] *= k; Rg[i] *= k; Rb[i] *= k; Hh[i] += 0.015;
  }
  return { W, H, B, hf: B.h, pu };
}

/* ================================================================ CRUSHED STONE
   512px = 3 ft (0.07 in/px). 3/4 in clean crushed stone: angular stones with flat fracture facets, piled in layers,
   dusty grey fines between. Height is a z-buffer in pixel units; each facet is a plane through one polygon edge and
   the stone's crest, so normals are exact and facets are crisp. */
const GRAVEL_FT = 3;
function gravelBase(B, n, f1, wn, Z){
  const R = B.r, G = B.g, Bb = B.b, NX = B.nx, NY = B.ny, Ro = B.ro;
  for (let i = 0; i < n; i++){
    const t = 0.5 + f1[i] * 0.8 + wn[i] * 0.5;
    R[i] = 62 + 26 * t; G[i] = 59 + 25 * t; Bb[i] = 55 + 22 * t;
    NX[i] = wn[i] * 0.8; NY[i] = f1[i] * 0.8; Ro[i] = 0.92; Z[i] = -1e3;
  }
}
const ST = { vx: new Float32Array(10), vy: new Float32Array(10), enx: new Float32Array(10), eny: new Float32Array(10),
             es: new Float32Array(10), ec: new Float32Array(10), fsh: new Float32Array(11), bb: new Float32Array(4) };
function stone(B, Z, W, H, wn, nv, cap, tX, tY, cx, cy, base, sr, sg, sb, bx0, bx1, by0, by1){
  const enx = ST.enx, eny = ST.eny, es = ST.es, ec = ST.ec, fsh = ST.fsh;
  const zTop = base + cap + (Math.abs(tX) + Math.abs(tY)) * Math.max(bx1 - bx0, by1 - by0);
  const Rr = B.r, Rg = B.g, Rb = B.b, Nx = B.nx, Ny = B.ny, Ro = B.ro;
  for (let y = Math.floor(by0); y <= Math.ceil(by1); y++){
    const py = y + 0.5, row = (y < 0 ? y + H : y >= H ? y - H : y) * W;
    for (let x = Math.floor(bx0); x <= Math.ceil(bx1); x++){
      const qx = x + 0.5, i0 = row + (x < 0 ? x + W : x >= W ? x - W : x);
      if (zTop <= Z[i0]) continue;
      let hmin = 1e9, fi = -1, dmin = 1e9;
      for (let v = 0; v < nv; v++){
        const d = qx * enx[v] + py * eny[v] + ec[v];
        if (d < -0.5){ fi = -2; break; }
        if (d < dmin) dmin = d;
        const hh = d * es[v];
        if (hh < hmin){ hmin = hh; fi = v; }
      }
      if (fi < 0) continue;
      if (hmin < 0) hmin = 0;
      let gx = 0, gy = 0, fs = fsh[nv];
      if (hmin > cap) hmin = cap; else { gx = es[fi] * enx[fi]; gy = es[fi] * eny[fi]; fs = fsh[fi]; }
      const zz = base + hmin + tX * (qx - cx) + tY * (py - cy);
      const i = row + (x < 0 ? x + W : x >= W ? x - W : x);
      if (zz <= Z[i]) continue;
      /* 1 px coverage ramp at the outline: blend instead of a hard stair-stepped edge; only claim the depth when the
         stone covers most of the pixel */
      let cov = dmin + 0.5; if (cov > 1) cov = 1;
      if (cov >= 0.5) Z[i] = zz;
      gx += tX; gy += tY;
      const g2 = gx * gx + gy * gy, steep = g2 > 1 ? 1 : Math.sqrt(g2);
      const kk = fs * (1 + 0.08 * (1 - steep)) * (1 + wn[i] * 0.12);    /* dust on flat tops */
      Rr[i] += (sr * kk - Rr[i]) * cov; Rg[i] += (sg * kk - Rg[i]) * cov; Rb[i] += (sb * kk - Rb[i]) * cov;
      const il = 1 / Math.sqrt(1 + g2);
      Nx[i] += (-gx * il - Nx[i]) * cov; Ny[i] += (-gy * il - Ny[i]) * cov; Ro[i] += (0.72 + 0.14 * steep - Ro[i]) * cov;
    }
  }
}
/* crevice occlusion: darken pixels lying below their neighbours (gaps between stones, undersides of facets) */
function gravelAO(B, Z, W, H, d, k, amt){
  const R = B.r, G = B.g, Bb = B.b;
  for (let y = 0; y < H; y++){
    const ru = ((y - d + H) % H) * W, rd = ((y + d) % H) * W, row = y * W;
    for (let x = 0; x < W; x++){
      const i = row + x, xl = x - d < 0 ? x - d + W : x - d, xr = x + d >= W ? x + d - W : x + d;
      const zl = Z[row + xl], zr = Z[row + xr], zu = Z[ru + x], zd = Z[rd + x];
      const m = (zl + zr + zu + zd) * 0.25 - Z[i];
      if (m <= 0) continue;
      let o = m * k; if (o > 1) o = 1;
      const f = 1 - amt * o;
      R[i] *= f; G[i] *= f; Bb[i] *= f;
    }
  }
}
function makeGravel(C, N, seed){
  const W = N, H = N, n = W * H, pu = GRAVEL_FT * 12 / N, rnd = C.rng(seed);
  const B = buffers(n), Z = B.h;
  const wn = white(n, seed + 2, tmp(n, 1));
  gravelBase(B, n, field(C, W, H, 64, 64, {octaves: 4, base: 8, seed: seed + 1}, tmp(n, 0)), wn, Z);
  const pal = [[120, 121, 124], [128, 127, 124], [136, 134, 130], [110, 111, 114], [126, 122, 117], [134, 129, 124], [116, 117, 117], [144, 142, 137]];
  const vx = ST.vx, vy = ST.vy, enx = ST.enx, eny = ST.eny, es = ST.es, ec = ST.ec, fsh = ST.fsh;
  const layers = 4, perLayer = 2700;   /* per 3 ft tile, independent of resolution */
  for (let k = layers - 1; k >= 0; k--){          /* top layer first: lower stones are mostly rejected by the z early-out */
    for (let s = 0; s < perLayer; s++){
      const fine = rnd() < 0.22;
      const rIn = fine ? 0.08 + 0.12 * rnd() : 0.24 + 0.22 * rnd();   /* radius in inches: 1/2..1 in stones, plus fines */
      const r = rIn / pu, cx = rnd() * W, cy = rnd() * H, base = (k + rnd() * 0.8) * 0.28 / pu;
      const nv = 5 + ((rnd() * 4) | 0), a0 = rnd() * 6.283;
      const elong = 0.7 + 0.3 * rnd(), ea = rnd() * 3.1416, eca = Math.cos(ea), esa = Math.sin(ea);
      for (let v = 0; v < nv; v++){
        const an = a0 + (v + (rnd() - 0.5) * 0.7) * 6.2832 / nv, rr = r * (0.75 + 0.4 * rnd());
        const lx = Math.cos(an) * rr, ly = Math.sin(an) * rr * elong;
        vx[v] = cx + lx * eca - ly * esa; vy[v] = cy + lx * esa + ly * eca;
      }
      const pkx = cx + (rnd() - 0.5) * r * 0.6, pky = cy + (rnd() - 0.5) * r * 0.6, pkh = r * (0.3 + 0.25 * rnd());
      let ok = true;
      for (let v = 0; v < nv; v++){
        const w2 = (v + 1) % nv, ex = vx[w2] - vx[v], ey = vy[w2] - vy[v], el = Math.sqrt(ex * ex + ey * ey) || 1;
        let nx = -ey / el, ny = ex / el;
        let dp = (pkx - vx[v]) * nx + (pky - vy[v]) * ny;
        if (dp < 0){ nx = -nx; ny = -ny; dp = -dp; }
        if (dp < 0.5){ ok = false; break; }
        enx[v] = nx; eny[v] = ny; es[v] = pkh / dp; ec[v] = -(vx[v] * nx + vy[v] * ny);
        fsh[v] = 0.9 + 0.2 * rnd();
      }
      if (!ok) continue;
      const cap = pkh * (0.6 + 0.35 * rnd()), tX = (rnd() - 0.5) * 0.5, tY = (rnd() - 0.5) * 0.5;
      fsh[nv] = 1.0 + 0.08 * rnd();
      const p = pal[(rnd() * pal.length) | 0], j = 0.86 + 0.28 * rnd(), sh = 0.62 + 0.38 * (k + 1) / layers;
      let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
      for (let v = 0; v < nv; v++){ if (vx[v] < bx0) bx0 = vx[v]; if (vx[v] > bx1) bx1 = vx[v]; if (vy[v] < by0) by0 = vy[v]; if (vy[v] > by1) by1 = vy[v]; }
      stone(B, Z, W, H, wn, nv, cap, tX, tY, cx, cy, base, p[0] * j * sh, p[1] * j * sh, p[2] * j * sh, bx0, bx1, by0, by1);
    }
  }
  let zmax = -1e9;
  for (let i = 0; i < n; i++){ if (Z[i] < -100) Z[i] = -0.1 / pu; if (Z[i] > zmax) zmax = Z[i]; }
  gravelAO(B, Z, W, H, 3, 0.22, 0.5);
  tent(B.nx, W, H, tmp(n, 2)); tent(B.ny, W, H, tmp(n, 2));     /* soften facet-edge normal steps (no outline lines) */
  return { W, H, B, zlo: -0.1 / pu, zhi: zmax };
}

/* ================================================================ SHREDDED BARK MULCH
   512px = 3 ft (0.07 in/px). Dark-dyed hardwood bark shreds in layers, fibrous, ragged ends, a few weathered grey
   and paler inner-wood pieces, near-black voids. Normals from the height field. */
const MULCH_FT = 3;
function mulchBase(B, n, f1, wn, hf){
  const R = B.r, G = B.g, Bb = B.b, Ro = B.ro;
  for (let i = 0; i < n; i++){
    const t = 0.5 + f1[i] * 0.8 + wn[i] * 0.4;
    R[i] = 22 + 14 * t; G[i] = 16 + 10 * t; Bb[i] = 12 + 7 * t; Ro[i] = 0.95; hf[i] = 0;
  }
}
/* one bark shred: ragged rectangle with fibres along its length, slightly convex across its width */
function strip(B, hf, W, H, cx, cy, dx, dy, L, w, curv, cr, cg, cb, zh, thick, tu, tv, fib, fph, fsc, rag, rph, eph){
  const hl = L * 0.5, hw = w * 0.5, hwm = hw * 1.25 + Math.abs(curv) * hl + 1, A = hl + 1;
  const ax = Math.abs(dx), ay = Math.abs(dy), ex = ax * A + ay * hwm, ey = ay * A + ax * hwm;
  const y0 = Math.floor(cy - ey), y1 = Math.ceil(cy + ey), ihl = 1 / (hl || 1), ihw2 = 1 / (hw * hw);
  const Rr = B.r, Rg = B.g, Rb = B.b, Ro = B.ro;
  for (let y = y0; y <= y1; y++){
    const py = y + 0.5 - cy;
    let lo = -ex - 1, hi = ex + 1;
    if (ax > 1e-4){ let a = (-A - py * dy) / dx, b = (A - py * dy) / dx; if (a > b){ const t = a; a = b; b = t; } if (a > lo) lo = a; if (b < hi) hi = b; }
    if (ay > 1e-4){ let a = (py * dx - hwm) / dy, b = (py * dx + hwm) / dy; if (a > b){ const t = a; a = b; b = t; } if (a > lo) lo = a; if (b < hi) hi = b; }
    if (lo > hi) continue;
    const xa = Math.ceil(cx + lo - 0.5), xb = Math.floor(cx + hi - 0.5), row = (y < 0 ? y + H : y >= H ? y - H : y) * W;
    for (let x = xa; x <= xb; x++){
      const qx = x + 0.5 - cx, u = qx * dx + py * dy;
      const v = -qx * dy + py * dx - curv * u * u * ihl;
      const av = v < 0 ? -v : v, au = u < 0 ? -u : u;
      /* ragged width along the length; ragged, fibrous ends (end position varies across the width) */
      const fe = fib[((v * 1.7 + eph) | 0) & 1023];
      let cov = hl * (0.88 - 0.12 * fe) - au + 0.5;
      if (cov <= 0) continue;
      const c2 = hw * (1 + 0.22 * rag[((u * 0.35 + rph) | 0) & 1023]) - av + 0.5;
      if (c2 < cov) cov = c2;
      if (cov <= 0) continue; if (cov > 1) cov = 1;
      const i = row + (x < 0 ? x + W : x >= W ? x - W : x);
      const vn2 = av * av * ihw2;
      const fv = fib[((v * fsc + fph) | 0) & 1023];
      const k = 1 + 0.17 * fv - 0.06 * vn2;
      Rr[i] += (cr * k - Rr[i]) * cov; Rg[i] += (cg * k - Rg[i]) * cov; Rb[i] += (cb * k - Rb[i]) * cov;
      const hh = zh + thick * (vn2 < 1 ? 1 - vn2 : 0) + 0.012 * fv + u * tu + v * tv;
      hf[i] += (hh - hf[i]) * cov;
      Ro[i] += (0.82 + 0.1 * fv - Ro[i]) * cov;
    }
  }
}
function makeMulch(C, N, seed){
  const W = N, H = N, n = W * H, pu = MULCH_FT * 12 / N, rnd = C.rng(seed);
  const B = buffers(n), hf = B.h;
  mulchBase(B, n, field(C, W, H, 64, 64, {octaves: 4, base: 6, seed: seed + 1}, tmp(n, 0)), white(n, seed + 2, tmp(n, 1)), hf);
  const fib = table(seed + 3), rag = table(seed + 4);
  const pal = [[74, 52, 38], [84, 59, 43], [64, 45, 33], [90, 62, 44], [80, 58, 44], [85, 73, 63], [94, 82, 70], [54, 39, 30], [99, 77, 56]];
  const pw = [0.22, 0.20, 0.16, 0.15, 0.12, 0.035, 0.02, 0.08, 0.015];      /* weathered grey and inner-wood chips are rare */
  const layers = 7, total = 9300;      /* per 3 ft tile (the hidden bottom layers are left out) */
  for (let k = 0; k < layers; k++){
    for (let s = 0; s < total / layers; s++){
      const z = (k + rnd()) / layers;
      const Lin = 0.45 + 2.6 * Math.pow(rnd(), 1.6), Win = 0.12 + 0.5 * Math.pow(rnd(), 1.5);
      const L = Lin / pu, w = Math.min(Win, Lin * 0.6) / pu;
      const ang = rnd() * 6.2832, dx = Math.cos(ang), dy = Math.sin(ang);
      let pr = rnd(), pi = 0; while (pi < pw.length - 1 && pr > pw[pi]){ pr -= pw[pi]; pi++; }
      const p = pal[pi], j = 0.85 + 0.3 * rnd(), sh = 0.45 + 0.55 * Math.pow(z, 0.8);
      const zh = z * 0.45, thick = 0.02 + 0.04 * rnd(), curv = (rnd() - 0.5) * 0.26;
      const tu = (rnd() - 0.5) * 0.12 * pu, tv = (rnd() - 0.5) * 0.25 * pu;      /* tilt, inches per pixel */
      strip(B, hf, W, H, rnd() * W, rnd() * H, dx, dy, L, w, curv, p[0] * j * sh, p[1] * j * sh, p[2] * j * sh, zh, thick, tu, tv,
            fib, rnd() * 1024, 2.5 + 2.0 * rnd(), rag, rnd() * 1024, rnd() * 1024);
    }
    /* stringy bark fibres lying across the top layers */
    if (k >= layers - 3){
      for (let s = 0; s < 700; s++){
        const z = (k + rnd()) / layers, L = (0.8 + 2.4 * rnd()) / pu, w = (0.035 + 0.04 * rnd()) / pu;
        const ang = rnd() * 6.2832, p = pal[(rnd() * 5) | 0], j = 0.9 + 0.35 * rnd(), sh = 0.45 + 0.55 * z;
        strip(B, hf, W, H, rnd() * W, rnd() * H, Math.cos(ang), Math.sin(ang), L, w, (rnd() - 0.5) * 0.5, p[0] * j * sh, p[1] * j * sh, p[2] * j * sh,
              z * 0.45 + 0.02, 0.01, 0, 0, fib, rnd() * 1024, 3.0, rag, rnd() * 1024, rnd() * 1024);
      }
    }
  }
  /* cavity darkening: wherever the surface lies below its surroundings (gaps between shreds, strip undersides) the
     bark is shadowed; this carries the depth instead of a steep normal map */
  const bl = gaussWrap(hf, tmp(n, 2), tmp(n, 3), W, H, 3.5), R = B.r, G = B.g, Bb = B.b;
  for (let i = 0; i < n; i++){
    const cav = bl[i] - hf[i];
    if (cav <= 0) continue;
    let k = cav * 3.2; k = 1 - (k > 0.5 ? 0.5 : k);
    R[i] *= k; G[i] *= k; Bb[i] *= k;
  }
  return { W, H, B, hf, pu };
}

/* ================================================================ macro noise: 256px RGB, three independent fbm fields */
function makeMacro(C, THREE){
  const S = 256, a = field(C, S, S, 128, 128, {octaves: 5, base: 4, seed: 9101}),
        b = field(C, S, S, 128, 128, {octaves: 5, base: 4, seed: 9203}),
        c = field(C, S, S, 128, 128, {octaves: 5, base: 4, seed: 9307});
  const cv = C.canvas(S, S), ctx = cv.getContext("2d"), img = ctx.createImageData(S, S), d = img.data;
  for (let i = 0, k = 0; i < S * S; i++, k += 4){ d[k] = (a[i] + 0.5) * 255; d[k+1] = (b[i] + 0.5) * 255; d[k+2] = (c[i] + 0.5) * 255; d[k+3] = 255; }
  ctx.putImageData(img, 0, 0);
  const t = C.texture(THREE, cv);
  t.anisotropy = 1;
  return t;
}

/* ================================================================ the shader patch
   Detail maps are sampled with HEX-TILE STOCHASTIC SAMPLING: the surface is covered by a triangle grid (cell = o.hex[0]
   feet); every grid vertex owns a random offset and rotation of the tile, each pixel reads the three surrounding
   vertices' samples and keeps the one whose texel stands highest (blade, chip, stone or clod), weighted toward the
   nearest vertex, with a narrow soft band. No lattice survives at any distance, and the switch between samples
   follows real outlines, so it is invisible. Top faces map from WORLD XZ (lawnBox and the lawn plane line up exactly;
   abutting soil pieces are seamless); side faces use the world-scaled vUv. Gradients come from the unrotated
   coordinate, so mip selection is continuous across switches.
   o = { key, tile ft, rep: number|0 (plane mode: vUv = uv*rep, only used on non-horizontal faces),
         hex: [cellFt, heightWeight, soft],
         s: [s0..s3] ft macro scales;  a: [a0..a3] tone amplitudes;  hue: warm/cool shift amplitude;  r: [r0, r1] roughness
         lawn: { side:[r,g,b] linear canopy colour seen at grazing, graze, stripe, band ft, clover:[lo,hi], dry, mow:[x,z] } | null
         damp: [lo, hi, darken, roughness] | null
         relief: [scale0 ft, amp0 ft, scale1 ft, amp1 ft, wallFactor] | null      large-scale lumps via the normal
         scrape: [bandFt, minSpacingFt, maxSpacingFt, slope] | null                 bucket-tooth grooves on walls
         topsoil: [gradeY, depthFt] | null                                          dark organic horizon at the top of cut walls
         bounce: [topGain, wallGain, warmMix, r, g, b] | null    stand-in for light bounced off sunlit soil inside a pit:
                 scales the image-based diffuse light (more on walls) and pulls its sky-blue toward a warm earth tint */
function groundPatch(THREE, m, T, o){
  const f = v => (+v).toFixed(5);
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  const key = "gnd2:" + o.key + (o.rep ? ":p" : "") + (o.topsoil ? ":t" + o.topsoil.join(",") : "") + (o.bounce ? ":b" + o.bounce.join(",") : "");
  const hx = o.hex, L = o.lawn, rl = o.relief, sc = o.scrape, ts = o.topsoil;
  m.extensions = { derivatives: true, shaderTextureLOD: true };    /* texture2DGradEXT on WebGL1 (WebGL2 maps it to textureGrad) */
  /* three hex samples: code generated per sample (GLSL ES 1.0 has no token pasting) */
  const S3 = fn => [1, 2, 3].map(fn).join("\n");
  const G = (tex, i) => `texture2DGradEXT(${tex}, gU${i}, gR${i} * gDx, gR${i} * gDy)`;
  m.onBeforeCompile = function(shader, renderer){
    if (prev) prev.call(this, shader, renderer);
    shader.uniforms.gMacro = {value: T.macro};
    if (L){ shader.uniforms.gClo = {value: T.clover}; shader.uniforms.gCloN = {value: T.cloverN}; }
    if (o.rep) shader.uniforms.gRep = {value: o.rep};
    let vs = shader.vertexShader;
    if (o.rep) vs = vs.replace("#include <uv_vertex>", "#ifdef USE_UV\n  vUv = uv * gRep;\n#endif");
    shader.vertexShader = "varying vec3 vGW;\nvarying vec3 vGN;\n" + (o.rep ? "uniform float gRep;\n" : "") +
      vs.replace("#include <project_vertex>", `#include <project_vertex>
        vec4 gW4 = vec4(transformed, 1.0);
        vec3 gN3 = objectNormal;
        #ifdef USE_INSTANCING
          gW4 = instanceMatrix * gW4;
          gN3 = mat3(instanceMatrix) * gN3;
        #endif
        vGW = (modelMatrix * gW4).xyz;
        vGN = normalize(mat3(modelMatrix) * gN3);`);
    const lawnMap = L ? `
          /* grazing-angle canopy fill: across a lawn you see blade sides, not the dark gaps between blades */
          vec3 gV = normalize(cameraPosition - vGW);
          float gNV = clamp(dot(normalize(vGN), gV), 0.0, 1.0);
          float gGr = pow(1.0 - gNV, 2.0) * ${f(L.graze)};
          gCol = mix(gCol, vec3(${f(L.side[0])}, ${f(L.side[1])}, ${f(L.side[2])}) * (0.85 + 0.3 * gH), gGr * (1.0 - gH * 0.6));
          /* clover / broadleaf patches, clustered in a few zones (gated by a very low-frequency field); plants appear one
             by one at a patch fringe (rank in cloverN.b); minified (far) it falls back to blending by density */
          float gMC = texture2D(gMacro, mat2(0.96, -0.28, 0.28, 0.96) * gP * ${f(1 / 53.0)} + vec2(0.61, 0.17)).b;
          float gMC2 = texture2D(gMacro, mat2(0.6, 0.8, -0.8, 0.6) * gP * ${f(1 / 6.3)} + vec2(0.33, 0.77)).g;
          float gMG = texture2D(gMacro, mat2(0.88, 0.47, -0.47, 0.88) * gP * ${f(1 / 171.0)} + vec2(0.07, 0.52)).g;
          float gMask = smoothstep(${f(L.clover[0])}, ${f(L.clover[1])}, gMC + (gMC2 - 0.5) * 0.35) * smoothstep(0.48, 0.6, gMG);
          ${S3(i => `vec4 gK${i} = ${G("gCloN", i)}; vec2 gKn${i} = (gK${i}.xy * 2.0 - 1.0) * gR${i};`)}
          float gRank = dot(gWt, vec3(gK1.b, gK2.b, gK3.b));
          vec2 gKn = gWt.x * gKn1 + gWt.y * gKn2 + gWt.z * gKn3;
          vec3 gTC = gWt.x * mapTexelToLinear(${G("gClo", 1)}).rgb + gWt.y * mapTexelToLinear(${G("gClo", 2)}).rgb + gWt.z * mapTexelToLinear(${G("gClo", 3)}).rgb;
          float gLod = log2(max(1.0, max(length(gDx), length(gDy)) * ${f(T.lawnRes)}));
          float gFar = smoothstep(0.6, 2.2, gLod);
          float gNear = smoothstep(-0.03, 0.03, gRank - (1.0 - gMask * 0.85)) * step(0.015, gRank);
          gCl = mix(gNear, gMask * 0.4, gFar);
          gCol = mix(gCol, gTC, gCl);
          /* dry, yellower patches and lusher, darker patches */
          float gDry = smoothstep(0.56, 0.8, gM2 * 0.7 + gMC2 * 0.3);
          gCol *= mix(vec3(1.0), vec3(1.3, 1.12, 0.8), gDry * ${f(L.dry)});
          float gLush = smoothstep(0.55, 0.8, gM0);
          gCol *= mix(vec3(1.0), vec3(0.9, 0.96, 0.92), gLush * 0.7);
          /* mowing stripes: passes along gMw; each pass lays the grass one way, so it reads light or dark by view */
          vec2 gMw = vec2(${f(L.mow[0])}, ${f(L.mow[1])});
          float gSc = dot(gP, vec2(-gMw.y, gMw.x)) / ${f(L.band)} + (gM1 - 0.5) * 1.6;
          float gSg = clamp(sin(gSc * 3.14159) * 3.0, -1.0, 1.0);
          float gAA = 1.0 - smoothstep(0.05, 0.2, fwidth(gSc));
          vec2 gVh = gV.xz / max(length(gV.xz), 1e-3);
          gStr = gSg * dot(gVh, gMw) * gAA * smoothstep(0.6, 0.9, gAN.y) * (1.0 - gCl * 0.6);
          gCol *= 1.0 + ${f(L.stripe)} * gStr;
          /* cut sod edges (vertical faces of lawn pieces) are soil and roots, not canopy */
          float gSod = 1.0 - smoothstep(0.3, 0.6, gAN.y);
          gCol = mix(gCol, vec3(0.06, 0.045, 0.03) * (0.8 + 0.4 * gH) + gCol * 0.25, gSod * 0.85);` : "";
    const reliefMap = rl ? `
          /* large-scale relief (lumps, ruts, bucket gouges) as a normal perturbation from two macro octaves, plus the
             relief height itself so lows collect moisture */
          {
            float gRe = ${f(1 / 128)};
            vec2 gQ0 = mat2(0.94, 0.34, -0.34, 0.94) * gP * ${f(1 / rl[0])} + vec2(0.31, 0.47);
            vec2 gQ1 = mat2(0.42, -0.91, 0.91, 0.42) * gP * ${f(1 / rl[2])} + vec2(0.83, 0.19);
            float gA0 = texture2D(gMacro, gQ0).g, gA1 = texture2D(gMacro, gQ1).b;
            vec2 gG0 = vec2(texture2D(gMacro, gQ0 + vec2(gRe, 0.0)).g - gA0, texture2D(gMacro, gQ0 + vec2(0.0, gRe)).g - gA0) * ${f(rl[1] / (rl[0] / 128))};
            vec2 gG1 = vec2(texture2D(gMacro, gQ1 + vec2(gRe, 0.0)).b - gA1, texture2D(gMacro, gQ1 + vec2(0.0, gRe)).b - gA1) * ${f(rl[3] / (rl[2] / 128))};
            /* back from the rotated noise space to gP space (transpose of the rotation) */
            vec2 gGr2 = gG0 * mat2(0.94, 0.34, -0.34, 0.94) + gG1 * mat2(0.42, -0.91, 0.91, 0.42);
            gRelH = (gA0 - 0.5) * ${f(rl[1])} + (gA1 - 0.5) * ${f(rl[3])};
            float gRk = gAN.y > 0.5 ? 1.0 : ${f(rl[4])};
            gRel = -(gGr2.x * gAx + gGr2.y * gBx) * gRk;
          }` : "";
    const scrapeMap = sc ? `
          /* excavator bucket-tooth scrapes on cut walls: shallow near-vertical U-grooves in horizontal bands (one band per
             bucket pass). Every pass has its own tooth spacing, offset and slight curve; teeth drop out at random and
             grooves break along their length, so the wall never reads as wood grain or sandstone. */
          {
            float gWall = 1.0 - smoothstep(0.3, 0.6, gAN.y);
            float gBv = gP.y / ${f(sc[0])} + gM3 * 1.2;
            float gBand = floor(gBv), gBf = gBv - gBand;
            float gHb = fract(sin(gBand * 12.9898 + 4.1) * 43758.5453);
            float gHb2 = fract(sin(gBand * 4.898 + 1.7) * 23421.631);
            float gSp = mix(${f(sc[1])}, ${f(sc[2])}, gHb2);
            float gS = (gP.x + gHb * 7.0 + (gM1 - 0.5) * 0.5 + gBf * gBf * (gHb - 0.5) * 0.7) / gSp;
            float gTid = floor(gS), gT = fract(gS) - 0.5;
            float gHg = fract(sin(gTid * 78.233 + gBand * 3.7) * 43758.5453);
            float gC = 0.5 + 0.5 * cos(6.2832 * gT);
            gGrv = gC * gC * gC;
            float gBrk = smoothstep(0.38, 0.58, texture2D(gMacro, vec2(gTid * 0.1372 + gBand * 0.31, gP.y * 0.29)).r);
            gScr = gWall * smoothstep(0.3, 0.6, gM2 * 0.7 + gHb * 0.5) * smoothstep(0.0, 0.2, gBf) * smoothstep(1.0, 0.72, gBf)
                 * (0.25 + 0.75 * gHg) * step(0.28, gHg) * gBrk;
            gRel += gAx * (gC * gC * sin(6.2832 * gT) * gScr * ${f(sc[3])} / gSp);
            gCol *= 1.0 - 0.025 * gGrv * gScr;
          }` : "";
    const topsoilMap = ts ? `
          /* dark organic topsoil horizon at the top of cut walls, with a wavy lower boundary */
          {
            float gWall2 = 1.0 - smoothstep(0.3, 0.6, gAN.y);
            float gB0 = ${f(ts[0] - ts[1])} + (gM2 - 0.5) * 0.45 + (gM3 - 0.5) * 0.25;
            float gTs = gWall2 * smoothstep(gB0 - 0.12, gB0 + 0.12, vGW.y) * (1.0 - smoothstep(${f(ts[0] + 0.05)}, ${f(ts[0] + 0.2)}, vGW.y));
            gCol = mix(gCol, gCol * vec3(0.6, 0.58, 0.6), gTs);
          }` : "";
    const dampMap = o.damp ? `
          gDp = smoothstep(${f(o.damp[0])}, ${f(o.damp[1])}, gM0 * 0.5 + gM2 * 0.3 + gM3 * 0.2 - gRelH * 0.8);
          gCol *= 1.0 - ${f(o.damp[2])} * gDp;` : "";
    shader.fragmentShader = `uniform sampler2D gMacro;
varying vec3 vGW;
varying vec3 vGN;
${L ? "uniform sampler2D gClo;\nuniform sampler2D gCloN;" : ""}
vec4 gHash4(vec2 p){
  vec4 p4 = fract(p.xyxy * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}
mat2 gRot(float a){ float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
/* perturbNormal2Arb with an explicit uv (the detail coordinate is not vUv on top faces) */
vec3 gPerturb(vec3 eye_pos, vec3 surf_norm, vec3 mapN, float fd, vec2 uv){
  vec3 q0 = dFdx(eye_pos), q1 = dFdy(eye_pos);
  vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1perp = cross(q1, surf_norm), q0perp = cross(surf_norm, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float sc = (det == 0.0) ? 0.0 : fd * inversesqrt(det);
  return normalize(T * (mapN.x * sc) + B * (mapN.y * sc) + surf_norm * mapN.z);
}
` + shader.fragmentShader
        .replace("#include <map_fragment>", `
          vec3 gAN = abs(vGN);
          vec2 gP = gAN.y > 0.5 ? vGW.xz : (gAN.x > 0.5 ? vec2(vGW.z, vGW.y) : vGW.xy);
          vec3 gAx = gAN.y > 0.5 ? vec3(1.0, 0.0, 0.0) : (gAN.x > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0));
          vec3 gBx = gAN.y > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
          vec2 gU = gAN.y > 0.5 ? vGW.xz * ${f(1 / o.tile)} : vUv;
          vec2 gDx = dFdx(gU), gDy = dFdy(gU);
          float gM0 = texture2D(gMacro, gP * ${f(1 / o.s[0])} + vec2(0.13, 0.71)).r;
          float gM1 = texture2D(gMacro, mat2(0.8, 0.6, -0.6, 0.8) * gP * ${f(1 / o.s[1])} + vec2(0.57, 0.29)).g;
          float gM2 = texture2D(gMacro, vec2(gP.y, -gP.x) * ${f(1 / o.s[2])} + vec2(0.41, 0.83)).b;
          float gM3 = texture2D(gMacro, mat2(0.6, -0.8, 0.8, 0.6) * gP * ${f(1 / o.s[3])} + vec2(0.23, 0.37)).r;
          /* hex-tile stochastic sampling (triangle grid; edge = cell) */
          vec2 gSt = gU * ${f(o.tile / hx[0])};
          vec2 gSk = vec2(gSt.x - 0.57735027 * gSt.y, 1.15470054 * gSt.y);
          vec2 gBs = floor(gSk), gFr = gSk - gBs;
          float gZ = 1.0 - gFr.x - gFr.y;
          vec3 gW; vec2 gC1, gC2, gC3;
          if (gZ > 0.0){ gW = vec3(gZ, gFr.y, gFr.x); gC1 = gBs; gC2 = gBs + vec2(0.0, 1.0); gC3 = gBs + vec2(1.0, 0.0); }
          else { gW = vec3(-gZ, 1.0 - gFr.y, 1.0 - gFr.x); gC1 = gBs + vec2(1.0); gC2 = gBs + vec2(1.0, 0.0); gC3 = gBs + vec2(0.0, 1.0); }
          float gSd = gAN.y > 0.5 ? 0.0 : (gAN.x > 0.5 ? 157.0 : 311.0);
          ${S3(i => `vec4 gH${i} = gHash4(gC${i} + gSd); mat2 gR${i} = gRot(gH${i}.z * 6.2831853); vec2 gU${i} = gR${i} * gU + gH${i}.xy;`)}
          ${S3(i => `vec4 gD${i} = ${G("roughnessMap", i)};`)}
          vec3 gHt = vec3(gD1.r, gD2.r, gD3.r);
          vec3 gSs = gW + gHt * ${f(hx[1])} * min(gW * 3.0, 1.0);
          float gMx = max(gSs.x, max(gSs.y, gSs.z));
          vec3 gWt = max(gSs - gMx + ${f(hx[2])}, 0.0);
          gWt /= (gWt.x + gWt.y + gWt.z);
          vec3 gCol = gWt.x * mapTexelToLinear(${G("map", 1)}).rgb + gWt.y * mapTexelToLinear(${G("map", 2)}).rgb + gWt.z * mapTexelToLinear(${G("map", 3)}).rgb;
          float gH = dot(gWt, gHt);
          float gCl = 0.0, gStr = 0.0, gDp = 0.0, gGrv = 0.0, gScr = 0.0, gRelH = 0.0;
          vec3 gRel = vec3(0.0);
          ${lawnMap}
          ${reliefMap}
          ${scrapeMap}
          ${topsoilMap}
          ${dampMap}
          gCol *= max(0.2, 1.0 + ${f(o.a[0])} * (gM0 - 0.5) * 2.0 + ${f(o.a[1])} * (gM1 - 0.5) * 2.0 + ${f(o.a[2])} * (gM2 - 0.5) * 2.0 + ${f(o.a[3])} * (gM3 - 0.5) * 2.0);
          gCol *= 1.0 + ${f(o.hue)} * (gM1 - 0.5) * 2.0 * vec3(1.0, 0.15, -0.9);
          diffuseColor.rgb *= gCol;`)
        .replace("#include <lights_fragment_maps>", `#include <lights_fragment_maps>
          ${o.bounce ? `#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
          {
            float gWb = 1.0 - smoothstep(0.3, 0.6, gAN.y);
            float gLu = dot(iblIrradiance, vec3(0.2126, 0.7152, 0.0722));
            iblIrradiance = mix(iblIrradiance, gLu * vec3(${f(o.bounce[3])}, ${f(o.bounce[4])}, ${f(o.bounce[5])}), ${f(o.bounce[2])})
                          * mix(${f(o.bounce[0])}, ${f(o.bounce[1])}, gWb);
          }
          #endif` : ""}`)
        .replace("#include <roughnessmap_fragment>", `
          float roughnessFactor = roughness * dot(gWt, vec3(gD1.g, gD2.g, gD3.g));
          roughnessFactor = clamp(roughnessFactor + ${f(o.r[0])} * (gM0 - 0.5) * 2.0 + ${f(o.r[1])} * (gM2 - 0.5) * 2.0, 0.04, 1.0);
          ${L ? "roughnessFactor = mix(roughnessFactor, 0.5, gCl * 0.5) * (1.0 - 0.06 * gStr);" : ""}
          ${o.damp ? `roughnessFactor = mix(roughnessFactor, ${f(o.damp[3])}, gDp);` : ""}
          ${sc ? "roughnessFactor -= 0.04 * gGrv * gScr;" : ""}`)
        .replace("#include <normal_fragment_maps>", `
          ${S3(i => `vec3 gN${i} = ${G("normalMap", i)}.xyz * 2.0 - 1.0; gN${i}.xy = gN${i}.xy * gR${i};`)}
          vec3 mapN = normalize(gWt.x * gN1 + gWt.y * gN2 + gWt.z * gN3);
          ${L ? "vec3 gNC = vec3(gKn, 0.0); gNC.z = sqrt(max(0.08, 1.0 - dot(gNC.xy, gNC.xy))); mapN = normalize(mix(mapN, gNC, gCl * (1.0 - gFar * 0.5)));" : ""}
          ${o.damp ? "mapN = normalize(mix(mapN, vec3(0.0, 0.0, 1.0), gDp * 0.3));" : ""}
          mapN.xy *= normalScale;
          normal = gPerturb(-vViewPosition, normal, mapN, faceDirection, gU);
          ${rl || sc ? "normal = normalize(normal + mat3(viewMatrix) * gRel);" : ""}`);
  };
  m.customProgramCacheKey = function(){ return (prevKey ? prevKey.call(this) : "") + key; };
  m.userData.ground = o;
  m.needsUpdate = true;
  return m;
}

/* ================================================================ 3D grass tufts (optional) */
function tuftTexture(C, seed){
  const S = 256, col = C.canvas(S, S), alp = C.canvas(S, S), rnd = C.rng(seed);
  const cc = col.getContext("2d"), ac = alp.getContext("2d");
  cc.fillStyle = "rgb(78,108,40)"; cc.fillRect(0, 0, S, S);
  ac.fillStyle = "#000"; ac.fillRect(0, 0, S, S);
  for (let b = 0; b < 70; b++){
    const x0 = S * (0.08 + 0.84 * rnd()), lean = (rnd() - 0.5) * S * 0.45, hgt = S * (0.35 + 0.63 * Math.pow(rnd(), 0.7));
    const w = S * (0.008 + 0.012 * rnd()), x1 = x0 + lean, y1 = S - hgt;
    const p = LAWN_PAL[(rnd() * LAWN_PAL.length) | 0], j = 0.8 + 0.3 * rnd();
    const g = cc.createLinearGradient(0, S, 0, y1);
    /* bottom 30% darkened like the lawn texture's canopy shading, so tufts sit IN the lawn */
    g.addColorStop(0, `rgb(${p[0] * 0.5 * j | 0},${p[1] * 0.56 * j | 0},${p[2] * 0.5 * j | 0})`);
    g.addColorStop(0.3, `rgb(${p[0] * 0.66 * j | 0},${p[1] * 0.72 * j | 0},${p[2] * 0.66 * j | 0})`);
    g.addColorStop(1, `rgb(${p[0] * j | 0},${p[1] * j | 0},${p[2] * j | 0})`);
    const path = new Path2D();
    path.moveTo(x0 - w, S);
    path.quadraticCurveTo(x0 + lean * 0.25 - w, S - hgt * 0.6, x1, y1);
    path.quadraticCurveTo(x0 + lean * 0.25 + w, S - hgt * 0.6, x0 + w, S);
    path.closePath();
    cc.fillStyle = g; cc.fill(path);
    ac.fillStyle = "#fff"; ac.fill(path);
  }
  return {col, alp};
}

REAL.ground = {
  /* generators exposed for profiling/tests */
  _gen: { makeLawn: (C, N, s) => makeLawn(C, N, s), makeClover: (C, N, s) => makeCloverOnto(C, makeLawn(C, N, s), s + 1), makeSoil: (C, N, s) => makeSoil(C, N, s),
          makeGravel: (C, N, s) => makeGravel(C, N, s), makeMulch: (C, N, s) => makeMulch(C, N, s) },
  create: function(THREE, renderer, opts){
    opts = opts || {};
    const C = REAL.core;
    const t0 = performance.now(), Tm = {}; let tl = t0;
    const lap = k => { const now = performance.now(); Tm[k] = Math.round(now - tl); tl = now; };
    const T = {};
    T.macro = makeMacro(C, THREE); lap("macro");

    /* lawn + clover (clover is drawn onto the same buffers after the lawn canvases are taken) */
    const lawn = makeLawn(C, 512, 4101); lap("lawnRaster");
    T.lawnRes = lawn.W;
    const lawnTex = { map: C.texture(THREE, rgbCanvas(C, lawn.W, lawn.H, lawn.B), {srgb: true}),
                      normalMap: C.texture(THREE, nrmCanvas(C, lawn.W, lawn.H, lawn.B)),
                      roughnessMap: C.texture(THREE, dataCanvas(C, lawn.W, lawn.H, lawn.B.h, lawn.B.ro, 0, 1)) };
    lap("lawnCanvas");
    makeCloverOnto(C, lawn, 4207); lap("cloverRaster");
    T.clover = C.texture(THREE, rgbCanvas(C, lawn.W, lawn.H, lawn.B), {srgb: true});
    T.cloverN = C.texture(THREE, nrmCanvas(C, lawn.W, lawn.H, lawn.B, lawn.B.h));
    lap("cloverCanvas");
    const lawnSide = [0.10, 0.16, 0.025];
    /* mowing direction in world XZ (opts.mowDeg, degrees from +X toward +Z); stripes run along it */
    const mowA = (opts.mowDeg == null ? 37 : opts.mowDeg) * Math.PI / 180, mowDir = [Math.cos(mowA), Math.sin(mowA)];      /* blade-side colour (linear) seen at grazing angles */
    const lawnPatch = (key, rep) => ({
      key, rep, tile: LAWN_FT, s: [97, 41, 13.3, 5.7], a: [0.09, 0.05, 0.045, 0.025], hue: 0.04, r: [0.05, 0.04],
      hex: [2.1, 0.3, 0.1],
      lawn: { side: lawnSide, graze: 0.75, stripe: 0.045, band: 1.75, clover: [0.74, 0.92], dry: 0.4, mow: mowDir }
    });
    function lawnMat(){
      const m = new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 1.0, metalness: 0});
      m.map = lawnTex.map; m.normalMap = lawnTex.normalMap; m.roughnessMap = lawnTex.roughnessMap;
      m.normalScale = new THREE.Vector2(0.9, 0.9);
      m.envMapIntensity = 0.85;
      return m;
    }
    const lawnBox = lawnMat();
    C.worldUV(lawnBox, {tile: [LAWN_FT, LAWN_FT], grain: "none", jitter: 1});
    groundPatch(THREE, lawnBox, T, lawnPatch("lawnBox", 0));

    /* soil */
    const so = makeSoil(C, 1024, 5101); lap("soilRaster");
    const soil = C.material(THREE, {
      map: rgbCanvas(C, so.W, so.H, so.B), normalMap: heightNrmCanvas(C, so.W, so.H, so.hf, so.pu, 1.0),
      roughnessMap: dataCanvas(C, so.W, so.H, so.hf, so.B.ro, -0.3, 0.8), normalScale: 1.0, roughness: 1.0,
      tile: [SOIL_FT, SOIL_FT], grain: "none", jitter: 1
    });
    groundPatch(THREE, soil, T, { key: "soil", tile: SOIL_FT, s: [23, 11.3, 4.1, 1.9], a: [0.10, 0.05, 0.06, 0.04], hue: 0.06, r: [0.03, 0.02],
      hex: [4.0, 0.35, 0.08], lawn: null, damp: [0.52, 0.72, 0.28, 0.78],
      relief: [11.0, 0.35, 3.1, 0.07, 0.35],          /* lumps and ruts on disturbed ground; a third as strong on walls */
      scrape: [2.3, 0.4, 0.9, 0.7],                   /* bucket passes 2.3 ft tall, teeth 0.4-0.9 ft apart */
      topsoil: [opts.gradeY == null ? 0 : opts.gradeY, 0.8],
      bounce: [1.1, 1.9, 0.45, 1.12, 1.0, 0.82] });     /* shaded pit walls get the warm light the sunlit soil throws back */
    soil.envMapIntensity = 1.3;
    lap("soilCanvas");

    /* gravel */
    const gr = makeGravel(C, 512, 6101); lap("gravelRaster");
    const gravel = C.material(THREE, {
      map: rgbCanvas(C, gr.W, gr.H, gr.B), normalMap: nrmCanvas(C, gr.W, gr.H, gr.B),
      roughnessMap: dataCanvas(C, gr.W, gr.H, gr.B.h, gr.B.ro, gr.zlo, gr.zhi), normalScale: 0.95, roughness: 1.0,
      tile: [GRAVEL_FT, GRAVEL_FT], grain: "none", jitter: 1
    });
    groundPatch(THREE, gravel, T, { key: "gravel", tile: GRAVEL_FT, s: [19, 8.7, 3.3, 1.3], a: [0.08, 0.04, 0.05, 0.03], hue: 0.03, r: [0.03, 0.02],
      hex: [1.7, 0.28, 0.06], lawn: null, damp: null, bounce: [1.25, 1.6, 0.6, 1.08, 1.0, 0.86] });
    gravel.envMapIntensity = 1.2;
    lap("gravelCanvas");

    /* mulch */
    const mu = makeMulch(C, 512, 7101); lap("mulchRaster");
    let hmax = 0; for (let i = 0; i < mu.hf.length; i++) if (mu.hf[i] > hmax) hmax = mu.hf[i];
    const mulch = C.material(THREE, {
      map: rgbCanvas(C, mu.W, mu.H, mu.B), normalMap: heightNrmCanvas(C, mu.W, mu.H, mu.hf, mu.pu, 0.55),
      roughnessMap: dataCanvas(C, mu.W, mu.H, mu.hf, mu.B.ro, 0, hmax), normalScale: 1.0, roughness: 1.0,
      tile: [MULCH_FT, MULCH_FT], grain: "none", jitter: 1
    });
    groundPatch(THREE, mulch, T, { key: "mulch", tile: MULCH_FT, s: [17, 7.9, 3.1, 1.4], a: [0.10, 0.05, 0.06, 0.04], hue: 0.05, r: [0.03, 0.02],
      hex: [2.0, 0.32, 0.06], lawn: null, damp: null });
    lap("mulchCanvas");

    /* let the raster buffers go (the canvases hold the results) */
    for (const k in POOL) delete POOL[k];
    for (const k in TMP) delete TMP[k];
    const ms = performance.now() - t0;
    REAL.ground.buildMs = ms; REAL.ground.timing = Tm;
    return {
      buildMs: ms,
      textures: T,
      variants: {
        soil:    {material: soil,    sample: [8, 3, 8],    count: 1},
        gravel:  {material: gravel,  sample: [8, 0.2, 8],  count: 1},
        mulch:   {material: mulch,   sample: [8, 0.08, 6], count: 1},
        lawnBox: {material: lawnBox, sample: [8, 0.05, 8], count: 1}
      },
      /* one big flat lawn plane: PlaneGeometry(sizeFeet, sizeFeet) with plain 0..1 UVs */
      lawnMaterial: function(sizeFeet){
        const rep = (sizeFeet || 100) / LAWN_FT, m = lawnMat();
        groundPatch(THREE, m, T, lawnPatch("lawnPlane", rep));
        return m;
      }
    };
  },

  /* 3D grass tufts for lawn edges (foundation, walks, beds): crossed alpha-tested cards whose normals point up so they
     shade like the lawn they grow from. areas: [{x0,x1,z0,z1}] feet at y = o.y (default 0). density: tufts per sq ft. */
  grass: function(THREE, renderer, o){
    o = o || {};
    const C = REAL.core, rnd = C.rng(o.seed || 77);
    const areas = o.areas || [{x0: -4, x1: 4, z0: -0.5, z1: 0.5}], dens = o.density == null ? 6 : o.density;
    const hgt = o.height || 0.24, maxN = o.max || 6000, y0 = o.y || 0;
    let area = 0; areas.forEach(a => area += Math.abs((a.x1 - a.x0) * (a.z1 - a.z0)));
    const count = Math.max(1, Math.min(maxN, Math.round(area * dens)));
    const pos = [], uv = [], nrm = [], idx = [];
    for (let q = 0; q < 2; q++){
      const a = q * Math.PI / 2, cx = Math.cos(a) * 0.5, sz = Math.sin(a) * 0.5, b = pos.length / 3;
      pos.push(-cx, 0, -sz,  cx, 0, sz,  cx, 1, sz,  -cx, 1, -sz);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      for (let k = 0; k < 4; k++) nrm.push(0, 1, 0);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const tx = tuftTexture(C, (o.seed || 77) + 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0, side: THREE.DoubleSide });
    mat.map = C.texture(THREE, tx.col, {srgb: true});
    mat.alphaMap = C.texture(THREE, tx.alp);
    mat.alphaTest = 0.5;
    /* DoubleSide flips the normal on back faces (normal *= faceDirection), which would point the up-normals down and
       leave half the blades black: undo the flip so both sides shade like the lawn they grow from */
    mat.onBeforeCompile = function(sh){
      sh.fragmentShader = sh.fragmentShader.replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n  normal *= faceDirection;");
    };
    mat.customProgramCacheKey = function(){ return "gndTuftUp"; };
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
    let i = 0;
    areas.forEach(a => {
      const n = Math.round(count * Math.abs((a.x1 - a.x0) * (a.z1 - a.z0)) / (area || 1));
      for (let k = 0; k < n && i < count; k++, i++){
        p.set(a.x0 + (a.x1 - a.x0) * rnd() + (rnd() - 0.5) * 0.25, y0 - 0.02, a.z0 + (a.z1 - a.z0) * rnd() + (rnd() - 0.5) * 0.25);   /* ragged edge */
        qq.setFromEuler(e.set((rnd() - 0.5) * 0.25, rnd() * Math.PI, (rnd() - 0.5) * 0.25));
        const h = hgt * (0.55 + 0.75 * rnd()), w = h * (1.0 + 0.8 * rnd());
        m4.compose(p, qq, s.set(w, h, w));
        mesh.setMatrixAt(i, m4);
        const v = 0.78 + 0.12 * rnd();      /* a little darker than white: the lawn texture carries canopy AO, the cards do not */
        mesh.setColorAt(i, c.setRGB(v * (0.97 + rnd() * 0.06), v, v * (0.95 + rnd() * 0.05)));
      }
    });
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }
};
})();
