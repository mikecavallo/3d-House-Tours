/* REAL.wood: procedural photoreal lumber for the build.
   REAL.wood.create(THREE, renderer, opts) -> { variants: { spf, pt, lvl, deck, deckDark, lattice } }
   Every variant is { material, sample:[sx,sy,sz] (feet), optional rot, spread, count }.
   variants.lattice also carries depthMaterial: set mesh.customDepthMaterial = it so the lattice casts a lattice-shaped
   shadow (r128's shadow pass ignores alpha maps and the world-UV patch otherwise).
   Grain runs along the canvas V axis (vertical) so core.worldUV(grain:"long") lays it along each board.
   All textures are generated with canvas 2D + REAL.core noise; deterministic (fixed seeds).
   A per-piece shader hook (woodHook) adds what a tiling texture cannot: a unique grain offset and tone per piece,
   eased (rounded, darker) long edges, end grain with growth-ring arcs on cut ends, and for LVL a separate
   rotary-veneer texture on the wide faces (plies only show on the narrow edges and ends). */
(function(){
"use strict";
const REAL = window.REAL = window.REAL || {};

/* ---------------------------------------------------------------- helpers */
function sstep(a, b, x){ let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

/* periodic 1-D value noise (period 1), output -1..1 */
function noise1(n, rnd){
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = rnd() * 2 - 1;
  return function(t){
    t = (t - Math.floor(t)) * n;
    const i = Math.floor(t), f = t - i, s = f * f * (3 - 2 * f);
    const a = v[i % n], b = v[(i + 1) % n];
    return a + (b - a) * s;
  };
}
function fbm1(n, oct, rnd){
  const fs = [];
  for (let k = 0; k < oct; k++) fs.push(noise1(n << k, rnd));
  return function(t){ let s = 0, a = 1, tot = 0; for (let k = 0; k < oct; k++){ s += fs[k](t) * a; tot += a; a *= 0.5; } return s / tot; };
}

/* sine via table (period 2pi), linear interpolation: plenty for ring geometry */
const SIN_N = 4096, SIN_T = new Float32Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN_T[i] = Math.sin(i / SIN_N * 2 * Math.PI);
const SIN_K = SIN_N / (2 * Math.PI);
function fsin(a){
  const p = a * SIN_K, fl = Math.floor(p), i = fl & (SIN_N - 1);
  return SIN_T[i] + (SIN_T[i + 1] - SIN_T[i]) * (p - fl);
}

/* low-res tileable 2-D field (core.fbm, normalised to -0.5..0.5) */
function lowField(C, w, h, o){
  const f = C.normalize(C.fbm(w, h, o));
  for (let i = 0; i < f.length; i++) f[i] -= 0.5;
  return {f, w, h};
}

/* scratch buffers reused between variants (keeps GC out of the build). One backing array per name, sized by the
   first (largest: SPF/deck are built first) request; later, smaller requests get a view of it. Names must not be live
   twice at once. */
const POOL = {};
function buf(name, n){
  const b = POOL[name];
  if (b && b.length >= n) return b.length === n ? b : b.subarray(0, n);
  return (POOL[name] = new Float32Array(n));
}
function clearPool(){ for (const k in POOL) delete POOL[k]; }

/* upsample a low-res periodic field to W x H (bilinear, wrap) */
/* separable: widen each low-res row to W once, then every output row is a plain lerp of two widened rows */
function up(F, W, H, out){
  out = out || new Float32Array(W * H);
  const w = F.w, h = F.h, f = F.f;
  const wide = buf("up.wide", w > 0 ? h * W : 1);
  for (let ry = 0; ry < h; ry++){
    const r0 = ry * w, o = ry * W;
    for (let x = 0; x < W; x++){
      let fx = (x + 0.5) / W * w - 0.5; if (fx < 0) fx += w;
      const a = fx | 0, b = a + 1 === w ? 0 : a + 1, t = fx - a;
      wide[o + x] = f[r0 + a] + (f[r0 + b] - f[r0 + a]) * t;
    }
  }
  for (let y = 0; y < H; y++){
    let fy = (y + 0.5) / H * h - 0.5; if (fy < 0) fy += h;
    const y0 = fy | 0, y1 = y0 + 1 === h ? 0 : y0 + 1, ty = fy - y0, a0 = y0 * W, a1 = y1 * W, o = y * W;
    for (let x = 0; x < W; x++){ const a = wide[a0 + x]; out[o + x] = a + (wide[a1 + x] - a) * ty; }
  }
  return out;
}

/* shared per-pixel grit (-0.5..0.5), xorshift32, 2^18 long; callers read it at different offsets: g[(i + off) & GM] */
let GRIT = null;
const GM = (1 << 18) - 1;
function grit(){
  if (GRIT) return GRIT;
  GRIT = new Float32Array(GM + 1);
  let s = 0x9E3779B9 | 0;
  for (let i = 0; i <= GM; i++){ s ^= s << 13; s ^= s >>> 17; s ^= s << 5; GRIT[i] = (s >>> 0) / 4294967296 - 0.5; }
  return GRIT;
}

/* canvases: opaque colour (RGB float 0..255; ImageData clamps; never carry alpha here, canvas premultiplies it away),
   grey data (0..1), normal map from height in inches */
const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function b8(v){ return v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0; }
function toCanvas(C, W, H, rgb){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  if (LE){
    const d32 = new Uint32Array(d.buffer);
    for (let i = 0, j = 0; i < W * H; i++, j += 3) d32[i] = (0xFF000000 | (b8(rgb[j+2]) << 16) | (b8(rgb[j+1]) << 8) | b8(rgb[j])) >>> 0;
  } else {
    for (let i = 0, j = 0, k = 0; i < W * H; i++, j += 3, k += 4){ d[k] = rgb[j]; d[k+1] = rgb[j+1]; d[k+2] = rgb[j+2]; d[k+3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function greyCanvas(C, W, H, g){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  if (LE){
    const d32 = new Uint32Array(d.buffer);
    for (let i = 0; i < W * H; i++){ const v = b8(g[i] * 255); d32[i] = (0xFF000000 | (v << 16) | (v << 8) | v) >>> 0; }
  } else {
    for (let i = 0, k = 0; i < W * H; i++, k += 4){ const v = g[i] * 255; d[k] = d[k+1] = d[k+2] = v; d[k+3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
/* tangent-space normal map from a tileable height field in INCHES; pu/pv = pixel size in inches. OpenGL convention. */
function normalCanvas(C, W, H, hf, pu, pv, k){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  const sx = k / (2 * pu), sy = k / (2 * pv), d32 = LE ? new Uint32Array(d.buffer) : null;
  for (let y = 0; y < H; y++){
    const ru = ((y - 1 + H) % H) * W, rd = ((y + 1) % H) * W, row = y * W;
    for (let x = 0; x < W; x++){
      const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
      const nx = -(hf[row + xr] - hf[row + xl]) * sx, ny = -(hf[ru + x] - hf[rd + x]) * sy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const R8 = (nx * inv * 127.5 + 128) | 0, G8 = (ny * inv * 127.5 + 128) | 0, B8 = (inv * 127.5 + 128) | 0;
      if (d32) d32[row + x] = (0xFF000000 | (B8 << 16) | (G8 << 8) | R8) >>> 0;
      else { const i = (row + x) * 4; d[i] = R8; d[i+1] = G8; d[i+2] = B8; d[i+3] = 255; }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function mat(C, THREE, W, H, rgb, rough, hgt, pu, pv, o){
  return C.material(THREE, Object.assign({
    map: toCanvas(C, W, H, rgb), normalMap: normalCanvas(C, W, H, hgt, pu, pv, 1), normalScale: 1,
    roughnessMap: greyCanvas(C, W, H, rough), roughness: 1, grain: "long", jitter: 1
  }, o));
}

/* ---------------------------------------------------------------- growth-ring field
   The board face is a plane cutting a log whose pith runs almost parallel to the board.
   Ring radius r = sqrt(s^2 + d^2): s = across-face distance from the pith line (made periodic with sin so the
   texture tiles), d = depth of the pith below the face, which drifts slowly along the length -> long flame /
   cathedral figure on flat-sawn areas, tight straight lines toward the rift/quarter-sawn sides.
   Knots: irregular ovals (or long spike knots) at stratified, irregularly spaced positions. Rings swirl round them;
   each gets a dark resinous core with radial checks (no bullseye rings), a darker boundary (dead knots) and a
   darker, redder resin halo.
   Output (per pixel): late 0..1 latewood, knot 0..1 core, kdet 0..1 core darkening detail, rim 0..1 dark knot boundary,
   halo 0..1, fib fibre streaks (-.5...5), low broad tone (-.5...5); rowX = pith line x (inches) per row. */
function ringField(C, W, H, o){
  const rnd = C.rng(o.seed);
  const uIn = o.uIn, vIn = o.vIn, N = W * H;
  const late = buf("rf.late", N), knot = buf("rf.knot", N).fill(0), rim = buf("rf.rim", N).fill(0), halo = buf("rf.halo", N).fill(0), kdet = buf("rf.kdet", N).fill(0);

  /* irregular ring widths -> phase lookup */
  const rMax = o.d0 + o.dAmp + o.dWarp + uIn / Math.PI + 4, step = 0.003, nT = Math.ceil(rMax / step) + 2;
  const bounds = [0]; let rr = 0;
  while (rr < rMax + 1){ rr += (1 / o.rpi) * (1 - o.ringVar + rnd() * 2 * o.ringVar); bounds.push(rr); }
  const phaseT = new Float32Array(nT);
  for (let i = 0, j = 0; i < nT; i++){ const r = i * step; while (bounds[j + 1] < r) j++; phaseT[i] = j + (r - bounds[j]) / (bounds[j + 1] - bounds[j]); }

  /* slow along-length curves: pith depth and pith sideways drift */
  const dN = fbm1(o.dCells || 2, 3, rnd), xN = fbm1(o.xCells || 2, 2, rnd);
  const rowD = new Float32Array(H), rowX = new Float32Array(H), x0 = rnd() * uIn;
  for (let y = 0; y < H; y++){ const t = y / H; rowD[y] = o.d0 + o.dAmp * dN(t); rowX[y] = x0 + o.xDrift * uIn * xN(t); }

  const sy = Math.max(1, Math.round(vIn / 48));
  const WL = up(lowField(C, 32, 64 * sy, {base: 1, sx: 2, sy: 3 * sy, octaves: 4, seed: o.seed + 11}), W, H, buf("f0", N));   /* ring wander */
  const WH = up(lowField(C, 64, 128 * sy, {base: 2, sx: 3, sy: 2 * sy, octaves: 3, seed: o.seed + 12}), W, H, buf("f1", N)); /* small wiggles */
  const FB = up(lowField(C, W >> 1, H >> 4, {base: 4, sx: 16, sy: sy, octaves: 3, persistence: 0.65, seed: o.seed + 13}), W, H, buf("f2", N)); /* fibres */

  /* knots (inches). u positions use shuffled column slots so no two knots share a column; v spacing is irregular. */
  const nK = o.knots || 0, knots = [];
  const slots = []; for (let i = 0; i < nK; i++) slots.push(i);
  for (let i = nK - 1; i > 0; i--){ const j = Math.floor(rnd() * (i + 1)); const t = slots[i]; slots[i] = slots[j]; slots[j] = t; }
  const gaps = []; let gs = 0;
  for (let i = 0; i < nK; i++){ const g = 0.3 + rnd() * 1.4; gaps.push(g); gs += g; }
  let yc = rnd() * vIn;
  for (let i = 0; i < nK; i++){
    const size = o.knotMin + Math.pow(rnd(), 1.5) * (o.knotMax - o.knotMin);
    const spike = i < (o.spikes || 0);
    let rx = size * 0.5, ry = size * 0.5 * (1.05 + rnd() * 0.4);
    if (spike){ rx = size * (1.0 + rnd() * 0.5); ry = size * (0.16 + rnd() * 0.06); }
    const nc = 2 + Math.floor(rnd() * 3), ck = [], ckL = [];
    for (let c = 0; c < nc; c++){ ck.push(rnd() * 6.283 - 3.1416); ckL.push(0.5 + rnd() * 0.45); }
    const dead = rnd() < (o.deadKnots || 0.3);
    knots.push({x: (slots[i] + 0.15 + rnd() * 0.7) / nK * uIn, y: yc, rx, ry, irx2: 1 / (rx * rx), iry2: 1 / (ry * ry),
                amp: (0.3 + rnd() * 0.3) * Math.min(size, 1.0) * (o.swirl == null ? 1 : o.swirl) * (spike ? 0.5 : 1),
                dead, ph: rnd() * 6.28, lob: 2 + Math.floor(rnd() * 3), ck, ckL,
                ext: ry * Math.sqrt(40), extX: rx * Math.sqrt(40)});
    yc += gaps[i] / gs * vIn;
  }

  const pi = Math.PI, aU = uIn / pi, halfU = uIn / 2, halfV = vIn / 2, invStep = 1 / step;
  const act = [], actQy = new Float64Array(nK + 1), actDy = new Float64Array(nK + 1);
  /* latewood profile over one ring and its running integral: a pixel's latewood is the profile averaged over the ring
     phase the pixel spans, so rings finer than a texel fade to an even tone instead of aliasing into dashes */
  const NP = 1024, prof = new Float32Array(NP), cum = new Float32Array(NP + 1);
  for (let i = 0; i < NP; i++){
    const t = (i + 0.5) / NP;
    prof[i] = t > 0.965 ? sstep(o.lwA, o.lwB, t) * (1 - (t - 0.965) / 0.07) : t < 0.035 ? sstep(o.lwA, o.lwB, 0.965) * (0.5 - t / 0.07) : sstep(o.lwA, o.lwB, t);
    cum[i + 1] = cum[i] + prof[i] / NP;
  }
  const cTot = cum[NP];
  const integ = p => { const fl = Math.floor(p), fr = (p - fl) * NP, k = fr | 0; return fl * cTot + cum[k] + (cum[k + 1] - cum[k]) * (fr - k); };
  const rowPh = new Float64Array(W), prevPh = new Float64Array(W);
  for (let y = 0; y < H; y++){
    const v = (y + 0.5) / H, yin = v * vIn, d0 = rowD[y], px = rowX[y];
    /* knots that reach this row */
    act.length = 0;
    for (let k = 0; k < nK; k++){
      const K = knots[k];
      let dy = yin - K.y; dy -= Math.round(dy / vIn) * vIn;
      if (Math.abs(dy) < K.ext){ actQy[act.length] = dy * dy * K.iry2; actDy[act.length] = dy; act.push(K); }
    }
    const nA = act.length;
    for (let x = 0; x < W; x++){
      const u = (x + 0.5) / W, xin = u * uIn, i = y * W + x;
      const wl = WL[i], wh = WH[i];
      const s = fsin(pi * (xin - px) / uIn + wl * o.thWarp) * aU;
      const d = d0 + wl * o.dWarp;
      let r = Math.sqrt(s * s + d * d) + wh * o.rWarp;
      let kc = 0, km = 0, kh = 0, kd = 0;
      for (let a = 0; a < nA; a++){
        const K = act[a];
        let dx = xin - K.x;
        if (dx > halfU) dx -= uIn; else if (dx < -halfU) dx += uIn;
        if (dx > K.extX || dx < -K.extX) continue;
        const q = dx * dx * K.irx2 + actQy[a];
        if (q < 40){
          r += K.amp * Math.exp(-q * 0.12);
          const hv = Math.exp(-q * 0.28); if (hv > kh) kh = hv;
          if (q < 1.7){
            const dy = actDy[a];
            const ang = Math.atan2(dy / K.ry, dx / K.rx);
            const qs = Math.sqrt(q) * (1 + 0.09 * Math.sin(ang * K.lob + K.ph) + wh * 0.3);
            const core = 1 - sstep(0.84, 1.0, qs);
            if (core > kc){
              kc = core;
              /* darker toward the branch pith, near-flat internal rings, a few radial drying checks */
              let det = 0.3 * (1 - sstep(0.0, 0.75, qs)) + 0.015 * Math.cos(qs * 18.0 + K.ph) + wh * 0.5 + (K.dead ? 0.12 : 0)
                        + 0.06 * Math.sin(ang * 5.0 + K.ph * 3.0 + qs * 4.0);
              for (let c = 0; c < K.ck.length; c++){
                let da = ang - K.ck[c]; da -= Math.round(da / 6.2832) * 6.2832;
                const lw = Math.abs(da) * qs * Math.min(K.rx, K.ry);    /* inches from the check line */
                if (qs > 0.08 && qs < K.ckL[c] && lw < 0.05) det += 0.3 * (1 - sstep(0.01, 0.05, lw)) * (1 - sstep(K.ckL[c] - 0.15, K.ckL[c], qs));
              }
              kd = det;
            }
            const rv = sstep(0.72, 0.9, qs) * (1 - sstep(0.96, 1.08, qs)) * (K.dead ? 1 : 0.35);
            if (rv > km) km = rv;
          }
        }
      }
      let ri = r * invStep; if (ri > nT - 2) ri = nT - 2; else if (ri < 0) ri = 0;
      const i0 = ri | 0;
      rowPh[x] = phaseT[i0] + (phaseT[i0 + 1] - phaseT[i0]) * (ri - i0);
      if (nA){ knot[i] = kc; rim[i] = km; halo[i] = kh; kdet[i] = kd > 1 ? 1 : kd; }
    }
    for (let x = 0; x < W; x++){
      const ph = rowPh[x];
      const gx = (rowPh[x === W - 1 ? 0 : x + 1] - rowPh[x === 0 ? W - 1 : x - 1]) * 0.5, gy = y ? ph - prevPh[x] : 0;
      const w = Math.sqrt(gx * gx + gy * gy) * 1.15;
      let lt;
      if (w < 0.02){ const t = ph - Math.floor(ph); lt = prof[(t * NP) | 0]; }
      else lt = (integ(ph + w * 0.5) - integ(ph - w * 0.5)) / w;
      late[y * W + x] = lt;
      prevPh[x] = ph;
    }
  }
  /* broad tone: the ring-wander field read half a tile away (uncorrelated in practice, saves an upsample);
     aux: the wiggle field read a quarter tile away, for per-variant mottles / wear / blotches */
  const hN = (H >> 1) * W, qN = (H >> 2) * W + (W >> 1);
  return {late, knot, rim, halo, kdet, fib: FB, W, H, uIn, vIn, rowX,
          low: i => WL[i < hN ? i + hN : i - hN], aux: i => WH[i < N - qN ? i + qN : i + qN - N]};
}

/* ---------------------------------------------------------------- SPF framing lumber
   Tile covers 9.6" x 96": wider than a 2x10 face, so joists and rims never show the same knot twice across the face,
   and long enough that a 16 ft joist only repeats twice (with a different per-piece offset on every piece). */
function makeSPF(C, THREE, R){
  const W = 256 * R, H = 1536 * R, uIn = 9.6, vIn = 96, N = W * H;
  const F = ringField(C, W, H, {seed: 101, uIn, vIn, rpi: 9, ringVar: 0.5, d0: 0.85, dAmp: 0.5, dCells: 4, xDrift: 0.22, xCells: 3,
                                 thWarp: 0.35, dWarp: 0.25, rWarp: 0.03, lwA: 0.78, lwB: 0.985,
                                 knots: 7, spikes: 1, knotMin: 0.3, knotMax: 1.2, deadKnots: 0.3, swirl: 0.6});
  const g = grit(), go = 7919;
  /* a few faint pitch / mineral streaks: long, thin, darker amber, tapering at both ends */
  const prnd = C.rng(104), streaks = [];
  for (let k = 0; k < 5; k++) streaks.push({x: prnd() * uIn, y: prnd() * vIn, len: 6 + prnd() * 14, w: 0.03 + prnd() * 0.06, a: 0.2 + prnd() * 0.3});
  const rgb = buf("rgb", N * 3), rough = buf("rough", N), hgt = buf("hgt", N);
  const act = [];
  for (let y = 0; y < H; y++){
    const v = (y + 0.5) / H;
    act.length = 0;
    for (let k = 0; k < streaks.length; k++){
      const P = streaks[k];
      let dy = v * vIn - P.y; dy -= Math.round(dy / vIn) * vIn;
      if (Math.abs(dy) > P.len * 0.5) continue;
      const tp = 1 - Math.pow(Math.abs(dy) / (P.len * 0.5), 2);
      act.push(P.x, P.a * tp, 1 / (P.w * P.w * tp + 1e-4));
    }
    for (let x = 0; x < W; x++){
      const i = y * W + x, u = (x + 0.5) / W;
      const f = F.fib[i], t = F.low(i), k = F.knot[i], h = F.halo[i], gr = g[(i + go) & GM];
      const mo = F.aux(i);
      /* grain bunches up (denser latewood) round knots: darker, never a pale ring */
      const L = F.late[i] + (1 - F.late[i]) * h * 0.28;
      let ps = 0;
      for (let a = 0; a < act.length; a += 3){
        let dx = u * uIn - act[a] + f * 0.05; dx -= Math.round(dx / uIn) * uIn;
        const e = dx * dx * act[a + 2];
        if (e < 9) ps = Math.max(ps, act[a + 1] * Math.exp(-e));
      }
      /* creamy earlywood, warmer tan latewood */
      let r = 215 - 32 * L, gg = 184 - 42 * L, b = 133 - 42 * L;
      /* broad drift: paler spruce <-> warmer pine/fir, plus a faint grey handling mottle */
      const warm = t * 1.4;
      r += 5 * warm; gg -= 1 * warm; b -= 12 * warm;
      const fm = 1 + f * 0.11 + gr * 0.03 + mo * 0.05;
      r *= fm; gg *= fm; b *= fm;
      /* resin halo round knots: darker and redder */
      r -= h * 16; gg -= h * 28; b -= h * 32;
      if (k > 0){
        const kd = F.kdet[i];
        const kr = 122 - 72 * kd, kg = 80 - 50 * kd, kb = 52 - 34 * kd;
        r += (kr - r) * k; gg += (kg - gg) * k; b += (kb - b) * k;
      }
      const m = F.rim[i];
      r += (74 - r) * m; gg += (48 - gg) * m; b += (31 - b) * m;
      r += (168 - r) * ps; gg += (120 - gg) * ps; b += (70 - b) * ps;
      rgb[i*3] = r; rgb[i*3+1] = gg; rgb[i*3+2] = b;
      rough[i] = 0.77 - L * 0.06 + f * 0.07 + gr * 0.05 - k * 0.16 + mo * 0.04;
      hgt[i] = f * 0.004 + L * 0.0012 + gr * 0.0008 + k * 0.001 - m * 0.003 - F.kdet[i] * k * 0.002;
    }
  }
  return mat(C, THREE, W, H, rgb, rough, hgt, uIn / W, vIn / H, {tile: [uIn / 12, vIn / 12]});
}

/* southern-yellow-pine deck stock: tile spans 12" x 96" (two boards' worth across, 8 ft along) so neighbouring
   5.5" boards show different parts of the log, and a board's knots fall at irregular spacing */
function deckField(C, R){
  return ringField(C, 256 * R, 1536 * R, {seed: 201, uIn: 12, vIn: 96, rpi: 5, ringVar: 0.45, d0: 2.0, dAmp: 0.8, dCells: 4, xDrift: 0.15, xCells: 3,
                                          thWarp: 0.2, dWarp: 0.35, rWarp: 0.02, lwA: 0.5, lwB: 0.82,
                                          knots: 3, knotMin: 0.6, knotMax: 1.1, deadKnots: 0.15, swirl: 0.4});
}
/* incised pressure-treated stock is usually hem-fir: finer rings, narrow latewood */
function ptField(C, R){
  return ringField(C, 256 * R, 1024 * R, {seed: 251, uIn: 6, vIn: 48, rpi: 8, ringVar: 0.5, d0: 1.0, dAmp: 0.5, dCells: 2, xDrift: 0.2,
                                          thWarp: 0.3, dWarp: 0.3, rWarp: 0.025, lwA: 0.7, lwB: 0.95,
                                          knots: 2, knotMin: 0.4, knotMax: 0.9, deadKnots: 0.3, swirl: 0.7});
}

/* ---------------------------------------------------------------- pressure-treated sill stock (incised) */
function makePT(C, THREE, F){
  const W = F.W, H = F.H, uIn = F.uIn, vIn = F.vIn, N = W * H;
  const g = grit(), go = 104729, rnd = C.rng(302);
  /* incising: staggered lens-shaped slits 0.3-0.5" long, columns every 0.5", rows every 0.75" (the incisor pattern is regular;
     depth and size vary tooth to tooth) */
  const cols = 12, rows = 64, cw = uIn / cols, rh = vIn / rows, slitW = 0.07;
  const jit = new Float32Array(cols * rows * 5);
  for (let i = 0; i < jit.length; i++) jit[i] = rnd() - 0.5;
  const rgb = buf("rgb", N * 3), rough = buf("rough", N), hgt = buf("hgt", N);
  const pxIn = uIn / W;
  for (let y = 0; y < H; y++){
    const v = (y + 0.5) / H, yin = v * vIn;
    const ry = Math.floor(yin / rh), rowOff = (ry & 1) ? 0.5 : 0, rmod = (ry % rows) * cols;
    for (let x = 0; x < W; x++){
      const i = y * W + x, u = (x + 0.5) / W, xin = u * uIn, gr = g[(i + go) & GM];
      const L = F.late[i] + (1 - F.late[i]) * F.halo[i] * 0.25, f = F.fib[i], k = F.knot[i];
      const bl = F.aux(i) * 1.3;
      const cxf = xin / cw - rowOff, cx = Math.floor(cxf + 0.5);
      const ci = ((((cx % cols) + cols) % cols) + rmod) * 5;
      const halfL = 0.15 + (jit[ci + 3] + 0.5) * 0.1;              /* 0.3 - 0.5" long */
      const sx = (cxf - cx) * cw + jit[ci] * 0.07, sy = (yin - (ry + 0.5) * rh) + jit[ci + 1] * 0.12;
      const ty = sy / halfL;
      let slit = 0, lip = 0;
      if (ty > -1.25 && ty < 1.25){
        /* lens: width tapers to points at both ends */
        const lens = ty > -1 && ty < 1 ? (1 - ty * ty) : 0;
        const hw = slitW * 0.5 * (0.8 + jit[ci + 4] * 0.4) * lens + pxIn * 0.25;
        const ax = Math.abs(sx);
        const str = 0.55 + (jit[ci + 2] + 0.5) * 0.45;
        slit = (1 - sstep(hw * 0.5, hw + pxIn * 0.9, ax)) * str * (lens > 0 ? 1 : 0);
        const lp = (ax - hw - pxIn) / (pxIn * 1.4);
        lip = Math.exp(-lp * lp) * (1 - slit) * Math.sqrt(lens) * str;
      }
      /* fresh copper-treated: pale olive-tan earlywood, deeper olive-brown latewood, greener copper blotches */
      let r = 164 - 34 * L, gg = 165 - 30 * L, b = 116 - 28 * L;
      const green = bl * 1.5;
      r -= 10 * green; gg += 1 * green; b -= 3 * green;
      const fm = 1 + f * 0.1 + gr * 0.035;
      r *= fm; gg *= fm; b *= fm;
      r -= F.halo[i] * 20; gg -= F.halo[i] * 22; b -= F.halo[i] * 20;
      if (k > 0){ const kd = F.kdet[i]; r += (112 - 64 * kd - r) * k; gg += (90 - 54 * kd - gg) * k; b += (56 - 34 * kd - b) * k; }
      const m = F.rim[i]; r += (56 - r) * m; gg += (48 - gg) * m; b += (30 - b) * m;
      /* slit: darker, greener inside (preservative pools there); faint raised lip */
      r = r * (1 - slit * 0.3) - lip * 3; gg = gg * (1 - slit * 0.2) - lip * 2; b = b * (1 - slit * 0.3) - lip * 3;
      rgb[i*3] = r; rgb[i*3+1] = gg; rgb[i*3+2] = b;
      rough[i] = 0.66 - L * 0.06 + f * 0.06 + gr * 0.05 + slit * 0.12 + bl * 0.1;
      hgt[i] = f * 0.006 + L * 0.003 + gr * 0.0015 - slit * 0.03 + lip * 0.004;
    }
  }
  return mat(C, THREE, W, H, rgb, rough, hgt, uIn / W, vIn / H, {tile: [uIn / 12, vIn / 12]});
}

/* ---------------------------------------------------------------- LVL: plies (narrow edges) */
function makeLVL(C, THREE, R){
  const W = 256 * R, H = 512 * R, uIn = 4.5, vIn = 48, N = W * H;
  const rnd = C.rng(401), g = grit(), go = 31337;
  /* plies across the tile: ~1/8" each, variable, with per-ply tone and an occasional darker (heartwood) ply */
  const nP = 36, th = [];
  let sum = 0;
  for (let i = 0; i < nP; i++){ const t = 0.75 + rnd() * 0.5; th.push(t); sum += t; }
  const edges = [0]; for (let i = 0; i < nP; i++) edges.push(edges[i] + th[i] / sum * uIn);
  const plyTone = [], plyWarm = [], plyJoint = [];
  for (let i = 0; i < nP; i++){ plyTone.push((rnd() - 0.5) * 0.16); plyWarm.push(rnd() < 0.22 ? 0.6 + rnd() * 0.4 : rnd() * 0.3); plyJoint.push(rnd() * vIn); }
  const plyOf = new Int16Array(W), plyPos = new Float32Array(W);
  for (let x = 0, p = 0; x < W; x++){ const xin = (x + 0.5) / W * uIn; while (edges[p + 1] < xin) p++; plyOf[x] = p; plyPos[x] = (xin - edges[p]) / (edges[p + 1] - edges[p]); }
  const ST = up(lowField(C, W >> 1, H >> 4, {base: 4, sx: 20, sy: 1, octaves: 3, persistence: 0.65, seed: 403}), W, H, buf("f0", N));
  const FG = up(lowField(C, 64, 128, {base: 2, sx: 1, sy: 6, octaves: 4, seed: 404}), W, H, buf("f1", N));
  const rgb = buf("rgb", N * 3), rough = buf("rough", N), hgt = buf("hgt", N);
  const pxIn = uIn / W;
  for (let y = 0; y < H; y++){
    const v = (y + 0.5) / H, yin = v * vIn;
    for (let x = 0; x < W; x++){
      const i = y * W + x, p = plyOf[x], pp = plyPos[x], gr = g[(i + go) & GM];
      const st = ST[i], fg = FG[i];
      /* phenolic glue line at each ply boundary */
      const dEdge = Math.min(pp, 1 - pp) * (edges[p + 1] - edges[p]);
      const glue = 1 - sstep(0.003, 0.003 + pxIn * 1.1, dEdge);
      /* veneer butt / scarf joint: short dark slanted line across the ply */
      let jd = yin - plyJoint[p] - (pp - 0.5) * 0.3; jd -= Math.round(jd / vIn) * vIn;
      const joint = 1 - sstep(0.03, 0.12, Math.abs(jd));
      /* rotary-cut figure: soft wavy bands, broken by plies */
      const fig = Math.sin((fg * 9 + p * 0.37) * 6.283) * 0.5 + 0.5;
      const w = plyWarm[p];
      const m = 1 + plyTone[p] + st * 0.14 + gr * 0.03 - fig * 0.06;
      let r = (212 - 10 * w) * m, gg = (166 - 26 * w) * m, b = (104 - 24 * w) * m;
      r += (110 - r) * glue * 0.5; gg += (72 - gg) * glue * 0.5; b += (42 - b) * glue * 0.5;
      r += (126 - r) * joint * 0.45; gg += (88 - gg) * joint * 0.45; b += (52 - b) * joint * 0.45;
      rgb[i*3] = r; rgb[i*3+1] = gg; rgb[i*3+2] = b;
      rough[i] = 0.6 + st * 0.1 + gr * 0.04 + glue * 0.08 - fg * 0.06;
      hgt[i] = st * 0.002 + gr * 0.0008 - glue * 0.002 - joint * 0.002;
    }
  }
  return mat(C, THREE, W, H, rgb, rough, hgt, uIn / W, vIn / H, {tile: [uIn / 12, vIn / 12]});
}

/* ---------------------------------------------------------------- LVL: wide face (one rotary-peeled face veneer)
   A rotary-cut veneer is nearly tangent to the growth rings, so the figure is broad, wandering contour bands of
   latewood rather than straight lines; plus a few glue-filled veneer splits and pin knots.
   Returns canvases (map, normal, roughness); the tile is 12" x 64". */
const LVL_FACE = {uIn: 12, vIn: 64};
function makeLVLFace(C, R){
  const W = 256 * R, H = 768 * R, uIn = LVL_FACE.uIn, vIn = LVL_FACE.vIn, N = W * H;
  const rnd = C.rng(451), g = grit(), go = 2718;
  const A = up(lowField(C, 24, 96, {base: 1, sx: 2, sy: 2, octaves: 3, persistence: 0.5, seed: 452}), W, H, buf("f0", N));
  const B = up(lowField(C, 64, 192, {base: 2, sx: 4, sy: 3, octaves: 3, seed: 453}), W, H, buf("f1", N));
  const FB = up(lowField(C, W >> 1, H >> 4, {base: 4, sx: 16, sy: 1, octaves: 3, persistence: 0.65, seed: 454}), W, H, buf("f2", N));
  const TN = up(lowField(C, 16, 64, {base: 2, sx: 1, sy: 3, octaves: 3, seed: 455}), W, H, buf("f3", N));
  /* glue-filled splits along the grain */
  const splits = [];
  for (let k = 0; k < 6; k++) splits.push({x: rnd() * uIn, y: rnd() * vIn, len: 3 + rnd() * 9, w: 0.025 + rnd() * 0.04});
  /* pin knots */
  const pins = [];
  for (let k = 0; k < 4; k++) pins.push({x: rnd() * uIn, y: rnd() * vIn, r: 0.08 + rnd() * 0.12});
  const rgb = buf("rgb", N * 3), rough = buf("rough", N), hgt = buf("hgt", N);
  const pxIn = uIn / W, act = [], pact = [];
  for (let y = 0; y < H; y++){
    const yin = (y + 0.5) / H * vIn;
    act.length = 0; pact.length = 0;
    for (let k = 0; k < pins.length; k++){
      const P = pins[k];
      let dy = yin - P.y; dy -= Math.round(dy / vIn) * vIn;
      if (Math.abs(dy) < P.r * 2) pact.push(P.x, dy * dy * 0.6, 1 / (P.r * P.r));
    }
    for (let k = 0; k < splits.length; k++){
      const S = splits[k];
      let dy = yin - S.y; dy -= Math.round(dy / vIn) * vIn;
      if (Math.abs(dy) < S.len * 0.5){ const t = dy / (S.len * 0.5); act.push(S.x, S.w * 0.5 * Math.pow(1 - t * t, 0.7) + pxIn * 0.2); }
    }
    for (let x = 0; x < W; x++){
      const i = y * W + x, xin = (x + 0.5) / W * uIn, gr = g[(i + go) & GM];
      const a = A[i], f = FB[i];
      /* contour bands: two cycles of the slope term keep it periodic across the tile */
      const ph = a * 4.5 + B[i] * 0.5 + xin / uIn * 7.0;
      const t = ph - Math.floor(ph);
      const late = sstep(0.6, 0.8, t) * (1 - sstep(0.9, 1.0, t)) + (t < 0.05 ? 0.5 * (1 - t / 0.05) : 0);
      let sp = 0;
      for (let c = 0; c < act.length; c += 2){
        let dx = xin - act[c] + f * 0.04; dx -= Math.round(dx / uIn) * uIn;
        const hw = act[c + 1];
        const v = 1 - sstep(hw * 0.4, hw + pxIn, Math.abs(dx));
        if (v > sp) sp = v;
      }
      let pk = 0;
      for (let c = 0; c < pact.length; c += 3){
        let dx = xin - pact[c]; dx -= Math.round(dx / uIn) * uIn;
        const q = (dx * dx + pact[c + 1]) * pact[c + 2];
        if (q < 2) pk = Math.max(pk, 1 - sstep(0.6, 1.2, q));
      }
      const m = 1 + f * 0.1 + gr * 0.03 + TN[i] * 0.1;
      let r = (214 - 16 * late) * m, gg = (170 - 21 * late) * m, b = (112 - 20 * late) * m;
      r += (110 - r) * sp * 0.45; gg += (72 - gg) * sp * 0.45; b += (42 - b) * sp * 0.45;
      r += (120 - r) * pk; gg += (74 - gg) * pk; b += (40 - b) * pk;
      rgb[i*3] = r; rgb[i*3+1] = gg; rgb[i*3+2] = b;
      rough[i] = 0.56 + f * 0.08 + gr * 0.05 - late * 0.04 + sp * 0.1 + TN[i] * 0.06;
      hgt[i] = f * 0.003 + late * 0.0015 + gr * 0.0006 - sp * 0.004;
    }
  }
  return {map: toCanvas(C, W, H, rgb), normalMap: normalCanvas(C, W, H, hgt, uIn / W, vIn / H, 1), roughnessMap: greyCanvas(C, W, H, rough)};
}

/* ---------------------------------------------------------------- stained deck stock
   One pass builds both stains from the same boards: "deck" (semi-transparent brown on the walking surface) and
   "dark" (more opaque, darker stain on joists, rails, posts, stringers). They share normal + roughness maps.
   Drying checks are lens-shaped, wander with the fibres, sit near the pith line and show a lighter raw-wood edge. */
function makeDeck(C, THREE, F){
  const W = F.W, H = F.H, uIn = F.uIn, vIn = F.vIn, N = W * H;
  const g = grit(), go = 9001, rnd = C.rng(504);
  const checks = [];
  for (let i = 0; i < 9; i++){
    const y = rnd() * vIn, row = Math.min(H - 1, Math.floor(y / vIn * H));
    checks.push({x: F.rowX[row] + (rnd() - 0.5) * 3.0, y, len: 2 + rnd() * 4, w: 0.03 + rnd() * 0.05, wob: noise1(3, rnd), ph: rnd(), amp: 0.03 + rnd() * 0.05});
  }
  const rgb = buf("rgb", N * 3), rgb2 = buf("rgb2", N * 3), rough = buf("rough", N), hgt = buf("hgt", N);
  /* stain colours (sRGB): earlywood / latewood ~6% apart (a solid-looking stain); the dark stain is more opaque */
  const E = [106, 76, 58], Lw = [101, 72, 55], E2 = [77, 53, 36], L2 = [72, 50, 34];
  const pxIn = uIn / W, act = [];
  for (let y = 0; y < H; y++){
    const v = (y + 0.5) / H, yin = v * vIn;
    act.length = 0;
    for (let c = 0; c < checks.length; c++){
      const K = checks[c];
      let dy = yin - K.y; dy -= Math.round(dy / vIn) * vIn;
      const hl = K.len * 0.5;
      if (Math.abs(dy) < hl){
        const t = dy / hl;
        act.push(K.x + K.amp * K.wob(t * 0.5 + K.ph), K.w * 0.5 * Math.pow(1 - t * t, 0.75));
      }
    }
    for (let x = 0; x < W; x++){
      const i = y * W + x, j = i * 3, xin = (x + 0.5) / W * uIn, gr = g[(i + go) & GM];
      const L = F.late[i] + (1 - F.late[i]) * F.halo[i] * 0.2, f = F.fib[i], k = F.knot[i], m = F.rim[i], h = F.halo[i];
      const worn = sstep(0.0, 0.42, F.aux(i) * 1.2);
      const fm = 1 + f * 0.13 + gr * 0.035 + F.low(i) * 0.05, fm2 = 1 + f * 0.09 + gr * 0.03 + F.low(i) * 0.04;
      let ck = 0, ce = 0;
      for (let c = 0; c < act.length; c += 2){
        let dx = xin - act[c] - f * 0.03; dx -= Math.round(dx / uIn) * uIn;
        const hw = act[c + 1], ad = Math.abs(dx);
        const cov = Math.min(1, (hw * 2 + 0.01) / pxIn);
        const core = (1 - sstep(hw * 0.3, hw + pxIn * 0.7, ad)) * cov;
        if (core > ck) ck = core;
        const e = (ad - hw - pxIn * 0.9) / (pxIn * 0.9);
        const edge = Math.exp(-e * e) * Math.min(1, hw / 0.012);
        if (edge > ce) ce = edge;
      }
      ce *= 1 - ck;
      const kd = F.kdet[i];
      for (let s = 0; s < 2; s++){
        const e = s ? E2 : E, l = s ? L2 : Lw, out = s ? rgb2 : rgb;
        const fs = s ? fm2 : fm;
        let r = (e[0] + (l[0] - e[0]) * L) * fs, gg = (e[1] + (l[1] - e[1]) * L) * fs, b = (e[2] + (l[2] - e[2]) * L) * fs;
        /* worn: stain thinned on earlywood -> lighter, greyer */
        const wE = worn * (1 - L * 0.5) * (s ? 0.45 : 1);
        r += (126 - r) * wE * 0.2; gg += (106 - gg) * wE * 0.2; b += (92 - b) * wE * 0.2;
        r -= h * 6; gg -= h * 6; b -= h * 5;
        if (k > 0){ const kk = k * (s ? 0.25 : 0.32); r += (76 - 34 * kd - r) * kk; gg += (52 - 26 * kd - gg) * kk; b += (38 - 20 * kd - b) * kk; }
        const mm = m * (s ? 0.22 : 0.3); r += (46 - r) * mm; gg += (32 - gg) * mm; b += (24 - b) * mm;
        /* check: raw, paler wood at the lips, dark open centre */
        const ee = ce * (s ? 0.35 : 0.5);
        r += (150 - r) * ee; gg += (118 - gg) * ee; b += (88 - b) * ee;
        r += (30 - r) * ck * 0.8; gg += (22 - gg) * ck * 0.8; b += (17 - b) * ck * 0.8;
        out[j] = r; out[j+1] = gg; out[j+2] = b;
      }
      /* intact stain keeps a soft sheen; worn wood goes matte */
      rough[i] = 0.54 + worn * 0.2 - L * 0.05 + f * 0.06 + gr * 0.05 + ck * 0.2 + ce * 0.08;
      /* weathered: earlywood erodes so latewood ridges stand proud */
      hgt[i] = L * 0.010 + f * 0.007 + gr * 0.0015 - ck * 0.03 + ce * 0.002 + k * 0.003;
    }
  }
  const deck = mat(C, THREE, W, H, rgb, rough, hgt, uIn / W, vIn / H, {tile: [uIn / 12, vIn / 12]});
  /* dark stain: own colour map, deck's relief at reduced strength, roughness pushed up ~15% (opaque stain is flatter) */
  const dark = C.material(THREE, {map: toCanvas(C, W, H, rgb2), roughness: 1.15, tile: [uIn / 12, vIn / 12], grain: "long", jitter: 1});
  dark.normalMap = deck.normalMap; dark.normalScale = new THREE.Vector2(0.6, 0.6); dark.roughnessMap = deck.roughnessMap;
  dark.needsUpdate = true;
  return {deck, dark};
}

/* ---------------------------------------------------------------- per-piece shader hook
   Chains onto core.worldUV's onBeforeCompile. Per instance (box piece) it works out, from the instance scale and
   the face normal: whether the face is a cut end (normal along a clearly longest axis), whether it is a wide face
   (normal along the thinnest axis), and the face-local position in feet with x across the grain, y along it.
   o: { end:{k, c, rpi, dr, plies}, ease:{w (inches), dark, rough, tilt}, tone:{lo, hi, warm:[r,g,b], grey, greyCol:[r,g,b]},
        face:{map, normalMap, roughnessMap, tile:[uFeet, vFeet]} } */
function woodHook(THREE, m, o){
  const SC = THREE.ShaderChunk, f = x => (+x).toFixed(4), v3 = a => "vec3(" + a.map(f).join(", ") + ")";
  const end = o.end, ease = o.ease, tone = o.tone, face = o.face;
  const faceTex = face ? {
    map: REAL.core.texture(THREE, face.map, {srgb: true}), normalMap: REAL.core.texture(THREE, face.normalMap), roughnessMap: REAL.core.texture(THREE, face.roughnessMap)
  } : null;
  const VARY = "varying float vWoodEnd;\nvarying float vWoodWide;\nvarying vec2 vWoodFP;\nvarying vec2 vWoodFD;\nvarying vec3 vWoodI;\n";
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = function(shader, renderer){
    if (prev) prev.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + VARY)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vWoodEnd = 0.0; vWoodWide = 0.0; vWoodFP = vec2(0.5); vWoodFD = vec2(1.0); vWoodI = vec3(0.5);
        #ifdef USE_INSTANCING
          vec3 weS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vec3 weN = abs(normal);
          float weA = weN.x > 0.5 ? weS.x : (weN.y > 0.5 ? weS.y : weS.z);
          float weMax = max(weS.x, max(weS.y, weS.z)), weMin = min(weS.x, min(weS.y, weS.z));
          float weMid = weS.x + weS.y + weS.z - weMax - weMin;
          vWoodEnd = (weA >= weMax * 0.999 && weMax > weMid * 2.0) ? 1.0 : 0.0;
          vWoodWide = (vWoodEnd < 0.5 && weA <= weMin * 1.001 && weMid > weMin * 1.5) ? 1.0 : 0.0;
          vec2 weD = weN.x > 0.5 ? vec2(weS.z, weS.y) : (weN.y > 0.5 ? vec2(weS.x, weS.z) : vec2(weS.x, weS.y));
          vec2 weP = uv * weD;
          if (weD.x > weD.y){ weP = weP.yx; weD = weD.yx; }
          vWoodFP = weP; vWoodFD = weD;
          /* per-piece seed from the instance index (WebGL2) so a piece keeps its grain while the build animation moves it;
             WebGL1 falls back to its position on a 1.5" grid */
          #if __VERSION__ >= 300
            float weH = fract(sin(float(gl_InstanceID) * 12.9898 + 0.731) * 43758.5453);
          #else
            float weH = fract(sin(dot(floor(instanceMatrix[3].xyz * 8.0 + 0.5), vec3(12.9898, 78.233, 37.719)) * 0.1618) * 43758.5453);
          #endif
          vWoodI = vec3(weH, fract(weH * 91.37 + 0.31), fract(weH * 53.11 + 0.77));
          #ifdef USE_UV
            vUv += vWoodI.yz;
            ${face ? `if (vWoodWide > 0.5) vUv = weP / vec2(${f(face.tile[0])}, ${f(face.tile[1])}) + vWoodI.zy;` : ""}
          #endif
        #endif`);

    let fs = shader.fragmentShader.replace("#include <common>", "#include <common>\n" + VARY +
      (face ? "uniform sampler2D woodFaceMap;\nuniform sampler2D woodFaceNormal;\nuniform sampler2D woodFaceRough;\n" : ""));

    /* albedo: wide-face veneer for LVL; cut ends take a heavily blurred tone of the map (no side-grain lines) */
    let mapChunk = SC.map_fragment.replace("vec4 texelColor = texture2D( map, vUv );",
      "vec4 texelColor = texture2D( map, vUv );\n" +
      (face ? "\ttexelColor = mix(texelColor, texture2D( woodFaceMap, vUv ), vWoodWide);\n" : "") +
      "\ttexelColor = mix(texelColor, texture2D( map, vUv, 4.0 ), vWoodEnd);");
    let block = "\nfloat woodEase = 0.0;\nvec2 woodTilt = vec2(0.0);\n{\n";
    if (tone){
      block += `  diffuseColor.rgb *= (${f(tone.lo)} + ${f(tone.hi - tone.lo)} * vWoodI.x) * mix(vec3(1.0), ${v3(tone.warm || [1, 1, 1])}, vWoodI.z);\n`;
      if (tone.grey){
        block += `  float woodG = ${f(tone.grey)} * smoothstep(0.45, 1.0, vWoodI.y);
  float woodLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, woodLum * ${v3(tone.greyCol || [1.3, 1.05, 0.9])}, woodG);\n`;
      }
    }
    if (end){
      /* end grain: growth-ring arcs round an off-centre pith (or ply stripes for LVL), darker, rougher */
      if (end.plies){
        block += `  float woodSc = (vWoodFD.x < vWoodFD.y ? vWoodFP.x : vWoodFP.y) * 12.0 * ${f(end.plies)};
  float woodPw = fwidth(woodSc);
  float woodLine = (1.0 - smoothstep(0.0, 0.12 + woodPw, abs(fract(woodSc + 0.5) - 0.5))) * (1.0 - smoothstep(0.3, 0.7, woodPw));
  diffuseColor.rgb *= mix(1.0, ${f(end.k)} * (1.0 - ${f(end.c)} * woodLine) * (0.94 + 0.12 * fract(floor(woodSc) * 0.618 + vWoodI.x)), vWoodEnd);\n`;
      } else {
        block += `  vec2 woodEp = vWoodFP * 12.0;
  float woodPa = vWoodI.z * 6.2832;
  vec2 woodPith = vWoodFD * 6.0 + vec2(cos(woodPa), sin(woodPa)) * (${f(end.pith[0])} + ${f(end.pith[1] - end.pith[0])} * vWoodI.y);
  vec2 woodDv = woodEp - woodPith;
  float woodR = length(woodDv), woodTh = atan(woodDv.y, woodDv.x);
  float woodPh = woodR * ${f(end.rpi)} + 0.22 * sin(woodTh * 3.0 + vWoodI.x * 6.2832) + 0.12 * sin(woodTh * 7.0 + woodR * 1.7);
  float woodT = fract(woodPh), woodPw = fwidth(woodPh);
  float woodLate = smoothstep(0.55, 0.8, woodT) * (1.0 - smoothstep(0.9, 1.0, woodT)) * (1.0 - smoothstep(0.25, 0.6, woodPw));
  float woodPor = fract(sin(dot(floor(woodEp * 40.0), vec2(12.9898, 78.233))) * 43758.5453);
  diffuseColor.rgb *= mix(1.0, ${f(end.k)} * (1.0 - ${f(end.c)} * woodLate) * (0.96 + 0.08 * woodPor), vWoodEnd);\n`;
      }
    }
    if (ease){
      /* eased long edges: only across the grain (cut ends stay square) */
      block += `  vec2 woodE01 = vec2(vWoodFP.x, vWoodFD.x - vWoodFP.x) * 12.0;
  vec2 woodEE = (1.0 - smoothstep(vec2(0.0), vec2(${f(ease.w)}), woodE01)) * (1.0 - vWoodEnd);
  woodEase = max(woodEE.x, woodEE.y);
  woodTilt = vec2(woodEE.y - woodEE.x, 0.0) * ${f(ease.tilt)};
  diffuseColor.rgb *= 1.0 - ${f(ease.dark)} * woodEase * woodEase;\n`;
    }
    block += "}\n";
    fs = fs.replace("#include <map_fragment>", mapChunk + block);

    let rChunk = SC.roughnessmap_fragment.replace("vec4 texelRoughness = texture2D( roughnessMap, vUv );",
      "vec4 texelRoughness = texture2D( roughnessMap, vUv );\n" + (face ? "\ttexelRoughness = mix(texelRoughness, texture2D( woodFaceRough, vUv ), vWoodWide);\n" : ""));
    rChunk += `\nroughnessFactor = min(1.0, roughnessFactor + ${f(end ? end.dr : 0)} * vWoodEnd + ${f(ease ? ease.rough : 0)} * woodEase);\n`;
    fs = fs.replace("#include <roughnessmap_fragment>", rChunk);

    const nChunk = SC.normal_fragment_maps
      .replace("vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;",
        face ? "vec3 mapN = mix(texture2D( normalMap, vUv ).xyz, texture2D( woodFaceNormal, vUv ).xyz, vWoodWide) * 2.0 - 1.0;"
             : "vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;")
      .replace("mapN.xy *= normalScale;", "mapN.xy *= normalScale * (1.0 - 0.6 * vWoodEnd);\n\tmapN.xy += woodTilt;");
    fs = fs.replace("#include <normal_fragment_maps>", nChunk);
    shader.fragmentShader = fs;
    if (faceTex){
      shader.uniforms.woodFaceMap = {value: faceTex.map};
      shader.uniforms.woodFaceNormal = {value: faceTex.normalMap};
      shader.uniforms.woodFaceRough = {value: faceTex.roughnessMap};
    }
  };
  const key = "|wood:" + JSON.stringify([end, ease, tone, face ? face.tile : 0]);
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = function(){ return (prevKey ? prevKey.call(this) : "") + key; };
  m.needsUpdate = true;
  return m;
}

/* ---------------------------------------------------------------- lattice skirt
   45-degree lattice: 1.5" slats on a 4" pitch (2.5" openings), front family laid over back family.
   The canvas covers 2 x 2 diamond periods (T = 2 * 4" * sqrt2 = 11.3") so it tiles exactly.
   Front faces only: on a thin box, a double-sided alpha material would show the box's back face (a mirrored, offset
   copy of the lattice) through every opening. */
function makeLattice(C, THREE, R){
  const W = 256 * R, H = W, p = 4, sw = 1.5, tIn = 0.3;
  const T = 2 * p * Math.SQRT2, pxIn = T / W, N = W * H, rs2 = Math.SQRT1_2, P4 = 4 * p;
  const rnd = C.rng(601), g = grit(), go = 4242;
  /* 4 slat loops (2 per family), each 4p long on the torus: own tone, grain phase, wobble, ring density */
  const S = [];
  for (let i = 0; i < 4; i++) S.push({tone: (rnd() - 0.5) * 0.14, off: rnd(), wob: noise1(5, rnd), wob2: noise1(13, rnd), rpi: 4 + rnd() * 3});
  const fibF = lowField(C, 64, 32, {base: 4, sx: 6, sy: 1, octaves: 3, seed: 603});
  const fw = fibF.w, fh = fibF.h, ff = fibF.f;
  const rgb = buf("rgb", N * 3), alpha = buf("alpha", N), hgt = buf("hgt", N), rough = buf("rough", N);
  const E = [84, 60, 45], Lw = [75, 53, 40];
  for (let y = 0; y < H; y++){
    for (let x = 0; x < W; x++){
      const i = y * W + x, X = (x + 0.5) * pxIn, Y = (y + 0.5) * pxIn, gr = g[(i + go) & GM];
      const tA = (X + Y) * rs2, sA = (X - Y) * rs2;            /* family A: across / along */
      const iA = Math.round(tA / p), dA = tA - iA * p, kA = ((iA % 2) + 2) % 2;
      const iB = Math.round(sA / p), dB = sA - iB * p, kB = ((iB % 2) + 2) % 2;   /* family B: across = sA, along = tA */
      const eA = sw / 2 - Math.abs(dA), eB = sw / 2 - Math.abs(dB);
      const cA = Math.min(1, Math.max(0, eA / pxIn + 0.5)), cB = Math.min(1, Math.max(0, eB / pxIn + 0.5));
      alpha[i] = cA > cB ? cA : cB;
      if (alpha[i] < 0.01){
        /* opening: opaque dark brown so mip levels average toward the shadowed gaps, never black */
        rgb[i*3] = E[0] * 0.45; rgb[i*3+1] = E[1] * 0.45; rgb[i*3+2] = E[2] * 0.45;
        hgt[i] = 0; rough[i] = 0.8;
        continue;
      }
      const front = cA > 0.5;
      let si, d, sc, e;
      if (front){ si = kA; d = dA; e = eA; sc = sA - (iA - kA) * p; }
      else { si = 2 + kB; d = dB; e = eB; sc = tA - (iB - kB) * p; }
      sc = (sc - Math.floor(sc / P4) * P4) / P4;
      const Sl = S[si];
      const gp = (d + Sl.wob(sc) * 0.5 + Sl.wob2(sc) * 0.1) * Sl.rpi + Sl.off;
      const L = sstep(0.55, 0.85, gp - Math.floor(gp));
      const fu = (((d / sw + 0.5) * 0.25 + si * 0.25) % 1) * fw, fv = sc * fh;
      const fb = ff[(Math.floor(fv) % fh) * fw + (Math.floor(fu) % fw)];
      let m = 1 + Sl.tone + fb * 0.12 + gr * 0.04;
      /* eased edges a touch darker; back slats occluded beside the front slats */
      m *= 1 - 0.2 * (1 - sstep(0, 0.14, e));
      if (!front){ m *= 0.88 * (1 - 0.45 * Math.exp(-Math.max(0, -eA) / 0.2)); }
      rgb[i*3] = (E[0] + (Lw[0] - E[0]) * L) * m; rgb[i*3+1] = (E[1] + (Lw[1] - E[1]) * L) * m; rgb[i*3+2] = (E[2] + (Lw[2] - E[2]) * L) * m;
      hgt[i] = (cA > 0.01 ? tIn * (1 + sstep(0, 0.12, eA)) : (cB > 0.01 ? tIn * sstep(0, 0.12, eB) : 0)) * 0.12 + L * 0.004 + fb * 0.004;
      rough[i] = 0.64 + fb * 0.08 + gr * 0.05 + (1 - sstep(0, 0.12, e)) * 0.05;
    }
  }
  const tile = [T / 12, T / 12];
  const m = mat(C, THREE, W, H, rgb, rough, hgt, pxIn, pxIn, {alphaMap: greyCanvas(C, W, H, alpha), alphaTest: 0.5, tile, grain: "none"});
  m.side = THREE.FrontSide;
  m.alphaToCoverage = true;
  /* matching shadow caster: same alpha map, same world-scaled UVs */
  const dm = new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking, alphaMap: m.alphaMap, alphaTest: 0.5});
  C.worldUV(dm, {tile, grain: "none", jitter: 1});
  return {material: m, depthMaterial: dm};
}

/* ---------------------------------------------------------------- public */
REAL.wood = {
  create: function(THREE, renderer, opts){
    opts = opts || {};
    const C = REAL.core, R = opts.res === 0.5 ? 0.5 : 1;   /* 0.5 = half-size canvases for weak devices */
    const t0 = performance.now(), T = {}; let tl = t0;
    const lap = k => { const n = performance.now(); T[k] = Math.round(n - tl); tl = n; };
    const spf = makeSPF(C, THREE, R); lap("spf");
    const D = makeDeck(C, THREE, deckField(C, R)), deck = D.deck, deckDark = D.dark; lap("deck+deckDark");
    const pt = makePT(C, THREE, ptField(C, R)); lap("pt");
    const lvl = makeLVL(C, THREE, R); lap("lvl");
    const lvlFace = makeLVLFace(C, R); lap("lvlFace");
    const L = makeLattice(C, THREE, R), lattice = L.material; lap("lattice");
    woodHook(THREE, spf, {end: {k: 0.84, c: 0.22, rpi: 10, dr: 0.08, pith: [1.0, 5.0]}, ease: {w: 0.12, dark: 0.06, rough: 0.04, tilt: 0.9},
                          tone: {lo: 0.93, hi: 1.05, warm: [1.03, 0.99, 0.92]}});
    woodHook(THREE, pt, {end: {k: 0.8, c: 0.24, rpi: 8, dr: 0.08, pith: [1.0, 5.0]}, ease: {w: 0.12, dark: 0.08, rough: 0.04, tilt: 0.9},
                         tone: {lo: 0.93, hi: 1.05, warm: [0.97, 1.01, 0.98]}});
    woodHook(THREE, lvl, {end: {k: 0.86, c: 0.3, plies: 8, dr: 0.06}, tone: {lo: 0.96, hi: 1.03, warm: [1.02, 0.99, 0.95]},
                          face: {map: lvlFace.map, normalMap: lvlFace.normalMap, roughnessMap: lvlFace.roughnessMap, tile: [LVL_FACE.uIn / 12, LVL_FACE.vIn / 12]}});
    woodHook(THREE, deck, {end: {k: 0.72, c: 0.25, rpi: 5, dr: 0.15, pith: [1.5, 6.0]}, ease: {w: 0.16, dark: 0.32, rough: 0.15, tilt: 1.0},
                           tone: {lo: 0.86, hi: 1.08, warm: [1.04, 0.98, 0.94], grey: 0.32, greyCol: [1.32, 1.08, 0.92]}});
    woodHook(THREE, deckDark, {end: {k: 0.8, c: 0.2, rpi: 5, dr: 0.1, pith: [1.5, 6.0]}, ease: {w: 0.14, dark: 0.22, rough: 0.1, tilt: 1.0},
                               tone: {lo: 0.9, hi: 1.05, warm: [1.03, 0.99, 0.95], grey: 0.12, greyCol: [1.3, 1.06, 0.92]}});
    lap("hooks");
    clearPool();
    GRIT = null;
    const ms = performance.now() - t0;
    REAL.wood.buildMs = ms; REAL.wood.timing = T;
    return {
      buildMs: ms,
      variants: {
        spf:      {material: spf,      sample: [0.125, 8, 0.29]},
        pt:       {material: pt,       sample: [12, 0.125, 0.46], spread: [0, 0, 0.6]},
        lvl:      {material: lvl,      sample: [8, 0.77, 0.29], spread: [0, 0, 0.6]},
        deck:     {material: deck,     sample: [8, 0.1, 0.46], spread: [0, 0, 0.48], count: 5},
        deckDark: {material: deckDark, sample: [8, 0.77, 0.125], spread: [0, 0, 1.33]},
        lattice:  {material: lattice,  sample: [6, 2.7, 0.05], count: 1, depthMaterial: L.depthMaterial}
      }
    };
  }
};
})();
