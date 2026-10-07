/* REAL.sheet: sheet goods for the photoreal build.
   osb      oriented strand board: subfloor, roof deck, and walls of sheets laid horizontally. grain "long": strands follow
            each piece's own long side, which is right for full 4x8 sheets whichever way they lie; a cut piece whose long
            side differs from its parent sheet's (a 4x2 over a window, a 1.5 ft rip) turns its strands 90 degrees.
   osbWall  the same board (same textures) for wall sheathing hung vertically, the usual way: grain "none", so on any
            vertical face the strands run vertically whatever size the piece is cut to.
   ply      sanded softwood plywood face (subfloor alternate). Built lazily, the first time variants.ply is read.
   Any box face whose smaller side is under 0.1 ft (the sheet's thickness) renders as a cut edge: OSB a dense, darker
   compressed core; ply five alternating veneer plies with glue lines.
   Albedo (map means): OSB sRGB (165,131,86), linear luminance 0.26, HSV saturation 0.49 (golden tan, darker and warmer
   than fresh SPF studs, as real sheathing is); ply sRGB (197,164,117), linear luminance 0.41 (about 1.6x the OSB).
   Build cost (this 4-core box, no WebGL page, min/median of several runs): OSB ~160/170 ms per page (create() builds
   only this), ply a further ~190/240 ms when first read. Canvases are cached per page; each create() makes new
   materials and textures over them.
   Everything is generated procedurally on canvas; deterministic (fixed seeds). */
(function(){
"use strict";
const REAL = window.REAL = window.REAL || {};

/* CPU-backed 2D context: these canvases are read back, and the OSB layers are ~1600 small sprite blits each, far
   cheaper on the software rasteriser than on a GPU canvas that then has to be read back */
function ctx2d(c){ return c.getContext("2d", {willReadFrequently: true}); }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function sstep(a, b, x){ const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
const now = () => (window.performance ? performance.now() : Date.now());

/* periodic 1D value noise: a lattice of n points (plus a wrap copy), sampled at t (lattice units) by nz, -1..1.
   nz is one monomorphic top-level function so the hot pixel loops can inline it; noise1 wraps it for setup code. */
function lattice(rnd, n){
  const lat = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) lat[i] = rnd() * 2 - 1;
  lat[n] = lat[0];
  return lat;
}
function nz(lat, t){
  const n = lat.length - 1, fl = Math.floor(t), f = t - fl, s = f * f * (3 - 2 * f);
  let i = (fl | 0) % n; if (i < 0) i += n;
  return lat[i] + (lat[i + 1] - lat[i]) * s;
}
function noise1(rnd, n){
  const lat = lattice(rnd, n);
  return t => nz(lat, t);
}

/* tileable height (Float32) -> tangent-space normal map canvas (OpenGL convention), written straight into ImageData.
   Optional per-column neighbours (XL, XR, XD = 1 / their distance * 2) keep the x slope from reaching across a seam. */
function normalCanvas(core, hf, w, h, strength, XL, XR, XD){
  const c = core.canvas(w, h), ctx = ctx2d(c), img = ctx.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++){
    const yr = y * w, yu = ((y - 1 + h) % h) * w, yd = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++){
      const xl = XL ? XL[x] : x === 0 ? w - 1 : x - 1, xr = XR ? XR[x] : x === w - 1 ? 0 : x + 1, k = XD ? XD[x] * 2 : 1;
      const dx = (hf[yr + xr] - hf[yr + xl]) * strength * k, dy = (hf[yu + x] - hf[yd + x]) * strength;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1), o = (yr + x) * 4;
      d[o] = (-dx * il * 0.5 + 0.5) * 255; d[o + 1] = (-dy * il * 0.5 + 0.5) * 255; d[o + 2] = (il * 0.5 + 0.5) * 255; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* small periodic field -> canvas with a 1px wrapped border, so a scaled drawImage of its inner rect tiles cleanly */
function wrapCanvas(core, f, w, h, fn){
  const c = core.canvas(w + 2, h + 2), ctx = ctx2d(c), img = ctx.createImageData(w + 2, h + 2), d = img.data;
  for (let y = 0; y < h + 2; y++) for (let x = 0; x < w + 2; x++){
    const v = f[((y + h - 1) % h) * w + ((x + w - 1) % w)], px = fn(v), o = (y * (w + 2) + x) * 4;
    d[o] = px[0]; d[o + 1] = px[1]; d[o + 2] = px[2]; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* OSB flake shading, one flake into its four atlas rectangles (as is, flipped in x, y, both). Its own function so the
   hot loop optimises on its own. u runs along the strand, v across it; the t* / e* tables are the flake's outline and
   shading profiles at half-pixel steps. */
const OSB_RIM = 1.3, OSB_RIMA = 0.28, OSB_SH0 = 52, OSB_SH1 = 38, OSB_SH2 = 24;
function osbFlakePixels(f, R, pw, AW, tLo, tHi, tG, tF, tB, eLt, eRt, hvm, rimR){
  const L = f.L, w = f.w, h = f.h, c = f.c, si = f.si, bands = f.bands, nb = bands.length, RIM = OSB_RIM;
  const fib = f.fib, med = f.med, spot = f.spot, slant = f.slant, edgeDark = f.edgeDark, rimA = f.rimA;
  const tr = f.tr, tg = f.tg, tb = f.tb, fibAmp = f.fibAmp, medAmp = f.medAmp;
  const ax0 = R[0][0], ay0 = R[0][1], ax1 = R[1][0], ay1 = R[1][1], ax2 = R[2][0], ay2 = R[2][1], ax3 = R[3][0], ay3 = R[3][1];
  for (let py = 0; py < h; py++){
    const dy = py + 0.5 - h / 2;
    /* clip the row to where the turned flake rectangle can be: u = dx*c + dy*si + L/2, v = dy*c - dx*si */
    let xa = 0, xb = w;
    if (Math.abs(c) > 1e-4){ const p0 = (-3.5 - L / 2 - dy * si) / c, p1 = (3.5 + L / 2 - dy * si) / c;
      xa = Math.max(xa, Math.floor(Math.min(p0, p1) + w / 2 - 1)); xb = Math.min(xb, Math.ceil(Math.max(p0, p1) + w / 2 + 1)); }
    if (Math.abs(si) > 1e-4){ const p0 = (dy * c - hvm) / si, p1 = (dy * c + hvm) / si;
      xa = Math.max(xa, Math.floor(Math.min(p0, p1) + w / 2 - 1)); xb = Math.min(xb, Math.ceil(Math.max(p0, p1) + w / 2 + 1)); }
    const qy = h - 1 - py, row0 = (ay0 + py) * AW + ax0, row1 = (ay1 + py) * AW + ax1, row2 = (ay2 + qy) * AW + ax2, row3 = (ay3 + qy) * AW + ax3;
    for (let px = xa; px < xb; px++){
      const dx = px + 0.5 - w / 2;
      const u = dx * c + dy * si + L / 2, v = -dx * si + dy * c;
      if (u < -3.5 || u > L + 3.5 || v < -hvm + 0.5 || v > hvm - 0.5) continue;
      const iu = ((u + 4) * 2 + 0.5) | 0, iv = ((v + hvm) * 2 + 0.5) | 0;
      let d = v - tLo[iu];
      const d2 = tHi[iu] - v, d3 = u - eLt[iv], d4 = eRt[iv] - u;
      if (d2 < d) d = d2; if (d3 < d) d = d3; if (d4 < d) d = d4;
      if (d < -0.6 - rimR) continue;
      /* coverage cv, plus (on lifted flakes) a soft contact shadow just outside the edge */
      const cv = d > 0.4 ? 1 : d < -0.6 ? 0 : d + 0.6;
      const sa = d > 0.4 || rimA === 0 ? 0 : rimA * clamp(1 - (-d - 0.6) / RIM, 0, 1);
      const A = cv + (1 - cv) * sa;
      if (A <= 0) continue;
      let r, g, b;
      if (cv === 0){ r = OSB_SH0; g = OSB_SH1; b = OSB_SH2; }
      else {
        const tt2 = v + slant * u + tB[iu];
        const fv = nz(fib, tt2 * 1.1 + tF[iu]), m = nz(med, tt2 * 0.2 + u * 0.012);
        let band = 0;
        for (let k = 0; k < nb; k++){ const B = bands[k], q = (v - B[0] - B[2] * u) / B[1]; if (q > -3 && q < 3) band += B[3] * Math.exp(-q * q); }
        const sp = nz(spot, u * 0.05 + tt2 * 0.15);
        const edge = d > 4 ? 1 : 1 - edgeDark * Math.exp(-(d > 0 ? d : 0));
        const sh = (1 + medAmp * m + fibAmp * fv - band - (sp > 0.75 ? (sp - 0.75) * 0.4 : 0)) * edge * tG[iu];
        const kc = cv / A, ks = (1 - cv) * sa / A;
        r = tr * sh * kc + OSB_SH0 * ks; g = tg * sh * kc + OSB_SH1 * ks; b = tb * sh * (1 - band * 0.4) * kc + OSB_SH2 * ks;
      }
      const qx = w - 1 - px;
      const word = ((A * 255 + 0.5) | 0) << 24 | (clamp(b + 0.5, 0, 255) | 0) << 16 | (clamp(g + 0.5, 0, 255) | 0) << 8 | (clamp(r + 0.5, 0, 255) | 0);
      pw[row0 + px] = word; pw[row1 + qx] = word; pw[row2 + px] = word; pw[row3 + qx] = word;
    }
  }
}

/* ------------------------------------------------------------------ OSB */
function buildOSB(core){
  const T = {}; let t = now();
  const N = 1024, M = N / 2, PPI = N / 48;    /* tile = 4 ft = 48 in -> 21.3 px per inch */
  const rnd = core.rng(7151);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.414;

  /* flake tones (sRGB) with weights: mostly honey / golden tan, some paler straw and browner flakes,
     a few orange heartwood strands and the odd dark bark-brown one */
  const tones = [
    [[190, 154, 102], 4.0], [[180, 142, 92], 4.0], [[196, 162, 112], 2.6], [[172, 134, 88], 3.0],
    [[198, 168, 122], 0.45], [[180, 128, 78], 0.5], [[160, 118, 76], 1.0], [[128, 94, 62], 0.25]
  ];
  const tw = tones.reduce((a, q) => a + q[1], 0);
  function pickTone(){
    let r = rnd() * tw;
    for (const q of tones){ r -= q[1]; if (r <= 0) return q[0]; }
    return tones[0][0];
  }

  /* 1. flake parameters. Each flake is rendered already turned to its final angle (strands along V with scatter, a few
     broad mid-toned ones lying across), so the layers below are laid with integer, translate-only blits: several
     times cheaper on the canvas rasteriser than rotated, filtered draws, and pixel-exact. */
  const NB = 112, F = [];
  for (let s = 0; s < NB; s++){
    const L = (3 + 3.3 * Math.pow(rnd(), 0.9)) * PPI;
    let Win = 0.7 + 0.6 * rnd();
    const kind = rnd();
    if (kind < 0.15) Win = 1.4 + 0.55 * rnd(); else if (kind < 0.25) Win = 0.42 + 0.28 * rnd();
    const W = Win * PPI, wobA = 0.4 + 0.04 * W;
    const base = pickTone(), lum = 0.95 + 0.07 * rnd(), warm = (rnd() - 0.5) * 0.06;
    const tr = base[0] * lum * (1 + warm), tg = base[1] * lum, tb = base[2] * lum * (1 - warm * 1.5);
    /* only broad, mid-toned flakes lie across the grain: thin or pale cross slivers become landmarks once the tile repeats */
    const cross = rnd() < 0.035 && Win > 1.2 && (tr + tg + tb) / 3 < 140;
    const th = Math.PI / 2 + (cross ? (rnd() < 0.5 ? -1 : 1) * (0.9 + 0.6 * rnd()) : gauss() * 0.3);
    const c = Math.cos(th), si = Math.sin(th), hu = L / 2 + 4, hv = W / 2 + wobA + 4;
    const w = Math.ceil(2 * (Math.abs(c) * hu + Math.abs(si) * hv)) + 2, h = Math.ceil(2 * (Math.abs(si) * hu + Math.abs(c) * hv)) + 2;
    F.push({L, W, wobA, tr, tg, tb, c, si, w, h,
      wob1: noise1(rnd, 6), wob2: noise1(rnd, 6), taper: rnd() < 0.3 ? rnd() * 0.45 : 0, taperEnd: rnd() < 0.5,
      jagL: noise1(rnd, 8), jagR: noise1(rnd, 8), combL: noise1(rnd, 40), combR: noise1(rnd, 40),
      AL: 1 + 3 * rnd(), AR: 1 + 3 * rnd(), CL: 0.3 + 1.6 * rnd() * rnd(), CR: 0.3 + 1.6 * rnd() * rnd(),
      sL: rnd() < 0.4 ? (rnd() * 2 - 1) * 1.1 : (rnd() * 2 - 1) * 0.2, sR: rnd() < 0.4 ? (rnd() * 2 - 1) * 1.1 : (rnd() * 2 - 1) * 0.2,
      fib: lattice(rnd, 96), med: lattice(rnd, 12), fibU: noise1(rnd, 16), spot: lattice(rnd, 24), bend: noise1(rnd, 6), bendA: 3 * rnd() * rnd(),
      slant: (rnd() * 2 - 1) * 0.06, bands: (() => { const nb = rnd() < 0.45 ? 1 + ((rnd() * 1.6) | 0) : 0, b = [];
        for (let k = 0; k < nb; k++) b.push([(rnd() - 0.5) * W * 0.95, 0.8 + 2.4 * rnd(), (rnd() * 2 - 1) * 0.1, 0.04 + 0.09 * rnd()]); return b; })(),
      /* pressed, not pasted: only about a third of the flakes have a lifted edge that throws a thin crevice shadow,
         and the in-flake edge and end-to-end shading is slight */
      rimA: rnd() < 0.35 ? OSB_RIMA * (0.6 + 0.4 * rnd()) : 0, grad: (rnd() * 2 - 1) * 0.05, edgeDark: 0.015 + 0.035 * rnd(),
      fibAmp: 0.02 + 0.03 * rnd(), medAmp: 0.05 + 0.06 * rnd()});
  }

  /* 2. shelf-pack four mirror images of every flake (as is, flipped in x, in y, in both) into one atlas */
  const AW = 1024, rects = [];
  let sx = 0, sy = 0, rowH = 0;
  for (const f of F) for (let k = 0; k < 4; k++){
    if (sx + f.w > AW){ sx = 0; sy += rowH; rowH = 0; }
    rects.push([sx, sy, f.w, f.h]); sx += f.w; rowH = Math.max(rowH, f.h);
  }
  const AH = sy + rowH, atlas = core.canvas(AW, AH), ac = ctx2d(atlas);
  const im = ac.createImageData(AW, AH), pw = new Int32Array(im.data.buffer);   /* RGBA bytes, little-endian words */

  /* 3. render each flake once, writing all four mirror images */
  for (let s = 0; s < NB; s++){
    const f = F[s], L = f.L, W = f.W;
    const R = [rects[s * 4], rects[s * 4 + 1], rects[s * 4 + 2], rects[s * 4 + 3]];
    const rimR = f.rimA > 0 ? OSB_RIM : 0;
    /* along-strand (u) and across-strand (v) profiles, tabulated at half-pixel steps */
    const nu = Math.ceil((L + 8) * 2) + 2, hvm = W / 2 + f.wobA + 4, nv = Math.ceil(hvm * 4) + 2;
    const tLo = new Float32Array(nu), tHi = new Float32Array(nu), tG = new Float32Array(nu), tF = new Float32Array(nu), tB = new Float32Array(nu);
    for (let j = 0; j < nu; j++){
      const u = j * 0.5 - 4, tu = clamp(u / L, 0, 1), tt = f.taperEnd ? tu : 1 - tu, hw = W / 2 * (1 - f.taper * tt * tt);
      tLo[j] = -hw + f.wobA * f.wob1(tu * 6); tHi[j] = hw + f.wobA * f.wob2(tu * 6);
      tG[j] = 1 + f.grad * (tu - 0.5); tF[j] = 0.4 * f.fibU(u * 0.07); tB[j] = f.bendA * f.bend(tu * 3);
    }
    const eLt = new Float32Array(nv), eRt = new Float32Array(nv);
    for (let j = 0; j < nv; j++){
      const v = j * 0.5 - hvm, vn = (v + W / 2) / W;
      eLt[j] = f.AL * (0.5 + 0.5 * f.jagL(vn * 8)) + f.CL * Math.abs(f.combL(vn * W * 0.5)) + Math.max(0, f.sL * v + Math.abs(f.sL) * W / 2);
      eRt[j] = L - (f.AR * (0.5 + 0.5 * f.jagR(vn * 8)) + f.CR * Math.abs(f.combR(vn * W * 0.5)) + Math.max(0, f.sR * v + Math.abs(f.sR) * W / 2));
    }
    osbFlakePixels(f, R, pw, AW, tLo, tHi, tG, tF, tB, eLt, eRt, hvm, rimR);
  }
  ac.putImageData(im, 0, 0);
  T.atlas = now() - t; t = now();

  /* 4. top layer on its own transparent canvas (its alpha is the surface the press flattened; holes in it are voids):
     random sprites at random integer positions, with wrapped copies so the tile repeats seamlessly */
  const cT = core.canvas(N, N), xt = ctx2d(cT), NR = rects.length;
  const flakeArea = 4.65 * 1.0 * 0.85 * PPI * PPI, count = Math.round(2.6 * N * N / flakeArea);
  for (let i = 0; i < count; i++){
    const b = rects[(rnd() * NR) | 0], x0 = ((rnd() * N) | 0) - (b[2] >> 1), y0 = ((rnd() * N) | 0) - (b[3] >> 1);
    for (let ox = -N; ox <= N; ox += N){
      if (x0 + ox + b[2] <= 0 || x0 + ox >= N) continue;
      for (let oy = -N; oy <= N; oy += N){
        if (y0 + oy + b[3] <= 0 || y0 + oy >= N) continue;
        xt.drawImage(atlas, b[0], b[1], b[2], b[3], x0 + ox, y0 + oy, b[2], b[3]);
      }
    }
  }
  /* 5. the layer below, only ever seen through the voids: the same flakes shifted (four translate-only wrapped copies),
     toned down as if in the crevice's shade, over a dark fill where both layers leave a gap */
  const cC = core.canvas(N, N), xc = ctx2d(cC);
  xc.fillStyle = "rgb(104,80,56)"; xc.fillRect(0, 0, N, N);
  const shx = 541, shy = 389;
  for (const ox of [shx - N, shx]) for (const oy of [shy - N, shy]) xc.drawImage(cT, ox, oy);
  xc.globalCompositeOperation = "multiply"; xc.fillStyle = "rgb(178,164,150)"; xc.fillRect(0, 0, N, N);
  xc.globalCompositeOperation = "source-over";
  xc.drawImage(cT, 0, 0);
  T.layers = now() - t; t = now();

  /* broad, soft tone variation across the panel (multiply) */
  const MW = 32, mot = core.normalize(core.fbm(MW, MW, {octaves: 3, base: 3, seed: 913}));
  const mc = wrapCanvas(core, mot, MW, MW, v => { const k = 233 + v * 22; return [k, k, k * 0.99]; });
  xc.globalCompositeOperation = "multiply";
  xc.imageSmoothingEnabled = true;
  xc.drawImage(mc, 1, 1, MW, MW, 0, 0, N, N);
  xc.globalCompositeOperation = "source-over";

  /* height and roughness at half resolution (keeps flake-level relief, drops fibre-level noise): the top layer's
     coverage gives the pressed surface vs the voids, colour luminance adds relief within it. Built before the stamp,
     so the ink is neither debossed nor rougher. */
  const cS = core.canvas(M, M), xs = ctx2d(cS), cA = core.canvas(M, M), xa = ctx2d(cA);
  xs.imageSmoothingEnabled = true; xs.drawImage(cC, 0, 0, M, M);
  xa.imageSmoothingEnabled = true; xa.drawImage(cT, 0, 0, M, M);
  const ic = xs.getImageData(0, 0, M, M), dc = ic.data, da = xa.getImageData(0, 0, M, M).data;
  const hf = new Float32Array(M * M), rn = core.fbm(64, 64, {octaves: 2, base: 8, seed: 515});
  for (let i = 0, o = 0; i < M * M; i++, o += 4){
    const l = (dc[o] * 0.3 + dc[o + 1] * 0.6 + dc[o + 2] * 0.1) / 255, a = da[o + 3] / 255;
    hf[i] = 0.6 * a + 0.3 * l;
    const n = rn[((((i / M) | 0) >> 3) << 6) + ((i % M) >> 3)] - 0.5;
    const rv = clamp(255 * (0.93 - 0.26 * a - 0.22 * (l - 0.45) + 0.08 * n), 0, 255);
    dc[o] = rv; dc[o + 1] = rv; dc[o + 2] = rv; dc[o + 3] = 255;
  }
  xs.putImageData(ic, 0, 0);
  const cN = normalCanvas(core, hf, M, M, 0.6);

  /* faint mill grade stamp on the colour map only (generic wording, no brand): patchy ink along the long axis */
  {
    const SW = 200, SHh = 76, st = core.canvas(SW, SHh), xst = ctx2d(st);
    xst.fillStyle = "#000"; xst.textBaseline = "top";
    xst.font = "bold 17px Arial, Helvetica, sans-serif"; xst.fillText("RATED SHEATHING", 12, 8);
    xst.font = "bold 13px Arial, Helvetica, sans-serif"; xst.fillText("24/16   7/16 INCH", 12, 29);
    xst.font = "11px Arial, Helvetica, sans-serif"; xst.fillText("SIZED FOR SPACING", 12, 45); xst.fillText("EXPOSURE 1   PS 2-10", 12, 58);
    const sd = xst.getImageData(0, 0, SW, SHh), sp = sd.data, inkN = core.fbm(64, 32, {octaves: 3, base: 6, seed: 404});
    for (let y = 0; y < SHh; y++) for (let x = 0; x < SW; x++){
      const o = (y * SW + x) * 4, nv = inkN[((y * 32 / SHh) | 0) * 64 + ((x * 64 / SW) | 0)];
      const k = clamp((nv - 0.3) * 3, 0, 1) * (0.7 + 0.3 * rnd());
      sp[o] = 30; sp[o + 1] = 30; sp[o + 2] = 44; sp[o + 3] *= 0.5 * k;
    }
    xst.putImageData(sd, 0, 0);
    xc.setTransform(0, -1, 1, 0, N * 0.47, N * 0.6);
    xc.drawImage(st, 0, 0);
    xc.setTransform(1, 0, 0, 1, 0, 0);
  }
  T.post = now() - t;
  return {map: cC, normalMap: cN, roughnessMap: cS, timing: T};
}

/* ------------------------------------------------------------------ plywood */
function buildPly(core){
  const T = {}; let t = now();
  const W = 512, H = 1024;                    /* tile = 4 ft x 8 ft, canvas V runs along the 8 ft grain; 10.7 px per inch */
  const rnd = core.rng(4242);
  /* Rotary-cut figure. The knife peels almost tangent to the growth rings, so the ring index across the face is
     phi = A * P(x + S(y)) + RAMP * y / H: P is a smooth across-grain profile (how far the wavy ring surface bulges
     toward the knife), S a slow meander along the grain and the ramp the log's taper. Bands run along the grain on
     P's flanks and close into nested cathedral arches over its crests and troughs. P has no along-grain variation of
     its own, so phi has no local extrema: closed loops appear only round knots. P uses Catmull-Rom value noise,
     which (unlike smoothstep noise) has no flat spot at every lattice point to spread into broad smeared bands. */
  function crNoise(r, n){
    const lat = new Float32Array(n);
    for (let i = 0; i < n; i++) lat[i] = r() * 2 - 1;
    return function(u){
      u = u % n; if (u < 0) u += n;
      const i = u | 0, f = u - i;
      const p0 = lat[(i + n - 1) % n], p1 = lat[i], p2 = lat[(i + 1) % n], p3 = lat[(i + 2) % n];
      return 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);
    };
  }
  const PR = 4;                               /* profile table samples per pixel */
  function profile(seed){
    const r = core.rng(seed), oc = [[5, 1], [11, 0.36], [23, 0.13], [47, 0.045]].map(([n, a]) => [crNoise(r, n), a, n]);
    const tab = new Float32Array(W * PR + 1);
    for (let j = 0; j <= W * PR; j++){ let v = 0; for (const [f, a, n] of oc) v += a * f(j / (W * PR) * n); tab[j] = v; }
    return tab;
  }
  function meander(seed, amp){
    const r = core.rng(seed), a = crNoise(r, 3), b = crNoise(r, 8), out = new Float32Array(H);
    for (let y = 0; y < H; y++) out[y] = amp * (a(y * 3 / H) + 0.25 * b(y * 8 / H));
    return out;
  }
  const PT = [profile(31), profile(57)], MS = [meander(32, 30), meander(58, 26)];
  /* fibre streaks: full resolution across the grain, 1/8 along it */
  const SW = 512, SH = 128;
  const fibF = core.normalize(core.fbm(SW, SH, {octaves: 3, base: 4, sx: 24, sy: 1, persistence: 0.6, seed: 77}));

  /* veneer strips: strip B occupies [sb0, sb1); strip A wraps around the tile edge */
  const sb0 = 178, sb1 = 362;
  const AMP = [3.4, 3.0], OFF = [0.0, 0.37], RAMP = [6, -7], WARP = 0.16;
  /* per-ring latewood start and darkness; the table period equals the ramp so the tile still wraps along V */
  const RLA = [], RDK = [];
  for (const n of RAMP){
    const la = new Float32Array(Math.abs(n)), dk = new Float32Array(Math.abs(n));
    for (let k = 0; k < la.length; k++){ la[k] = 0.5 + 0.18 * rnd(); dk[k] = 0.78 + 0.3 * rnd(); }
    RLA.push(la); RDK.push(dk);
  }
  /* across-grain neighbours for phase gradients that never reach across a veneer joint (the phase jumps there) */
  const XL = new Int32Array(W), XR = new Int32Array(W), XD = new Float32Array(W);
  const strip = x => (x >= sb0 && x < sb1) ? 1 : 0;
  for (let x = 0; x < W; x++){
    let l = (x + W - 1) % W, r = (x + 1) % W;
    if (strip(l) !== strip(x)) l = x;
    if (strip(r) !== strip(x)) r = x;
    XL[x] = l; XR[x] = r; XD[x] = (l === x || r === x) ? 1 : 0.5;
  }

  /* knots: phase bumps the rings close around (the only place closed loops should appear) */
  const bump = new Float32Array(W * H), knotD = new Float32Array(W * H);
  for (let i = 0; i < 6; i++){
    const kx = rnd() * W, ky = rnd() * H, r = 4 + 6 * rnd(), a = (rnd() < 0.5 ? -1 : 1) * (0.55 + 0.6 * rnd()), dark = rnd() < 0.65;
    const ex = Math.ceil(r * 6), ey = Math.ceil(r * 6 / 0.32);
    for (let yy = -ey; yy <= ey; yy++){
      const y = ((Math.round(ky) + yy) % H + H) % H, dy = yy * 0.32;
      for (let xx = -ex; xx <= ex; xx++){
        const x = ((Math.round(kx) + xx) % W + W) % W, q = (xx * xx + dy * dy) / (r * r * 9);
        if (q > 4) continue;
        const i2 = y * W + x;
        bump[i2] += a * Math.exp(-q);
        if (dark && q < 0.2){ const qq = (xx * xx + dy * dy * 4) / (r * r * 0.12); knotD[i2] = Math.max(knotD[i2], Math.exp(-qq)); }
      }
    }
  }
  /* repairs: boat-shaped veneer patches (router "footballs") and filled synthetic patches */
  const patchE = new Float32Array(W * H).fill(99), patchK = new Int8Array(W * H).fill(-1);
  const patches = [];
  for (let i = 0; i < 6; i++){
    const synth = i >= 4;
    const pt = synth
      ? {x: rnd() * W, y: rnd() * H, a: 10 + 10 * rnd(), b: 6 + 4 * rnd(), synth: true, ph: rnd() * 10, sq: 0.35}
      : {x: rnd() * W, y: rnd() * H, a: 24 + 8 * rnd(), b: 10 + 3 * rnd(), synth: false, ph: rnd() * 10, sq: 0};
    patches.push(pt);
    for (let yy = -Math.ceil(pt.a + 2); yy <= Math.ceil(pt.a + 2); yy++){
      const y = ((Math.round(pt.y) + yy) % H + H) % H, ty = yy / pt.a;
      if (Math.abs(ty) > 1.05) continue;
      /* boat: lens with pointed ends; synthetic: rounder blob */
      const wy = pt.synth ? pt.b * Math.sqrt(Math.max(0, 1 - ty * ty)) * (1 + 0.15 * Math.sin(ty * 5 + pt.ph)) : pt.b * (1 - ty * ty);
      for (let xx = -Math.ceil(pt.b + 3); xx <= Math.ceil(pt.b + 3); xx++){
        const x = ((Math.round(pt.x) + xx) % W + W) % W, e = Math.abs(xx) - wy, i2 = y * W + x;
        if (e < 1.5 && e < patchE[i2]){ patchE[i2] = e; patchK[i2] = i; }
      }
    }
  }
  T.setup = now() - t; t = now();

  const cC = core.canvas(W, H), xc = ctx2d(cC), ic = xc.createImageData(W, H);
  const cR = core.canvas(W, H), xr = ctx2d(cR), ir = xr.createImageData(W, H);
  const MW = 32, MH = 64, mot = core.normalize(core.fbm(MW, MH, {octaves: 3, base: 2, sx: 1, sy: 2, seed: 5}));
  const RX = new Float32Array(W);
  for (let x = 0; x < W; x++) RX[x] = RAMP[strip(x)];
  /* the per-pixel passes live in their own small functions (plain locals, no closure captures) so each hot loop
     optimises on its own */
  const S = {W, H, PR, PT0: PT[0], PT1: PT[1], MS0: MS[0], MS1: MS[1], AMP, OFF, RAMP, RX, sb0, sb1, fibF, SW, SH, bump, knotD,
    patchE, patchK, patches, XL, XR, XD, WARP, RLA0: RLA[0], RLA1: RLA[1], RDK0: RDK[0], RDK1: RDK[1], mot, MW, MH,
    early: [206, 180, 137], late: [166, 116, 70],
    P0: new Float32Array(W * H), PH: new Float32Array(W * H), FB: new Float32Array(W * H), hf: new Float32Array(W * H)};
  plyPhase(S);
  plyWarp(S);
  T.phase = now() - t; t = now();
  plyColour(S, new Int32Array(ic.data.buffer), new Int32Array(ir.data.buffer));
  xc.putImageData(ic, 0, 0); xr.putImageData(ir, 0, 0);
  /* normal map at half resolution (2x2 box average; the ply's relief is gentle); strength halved-ish so the slopes
     match the full-size map (each texel now spans twice the distance) */
  const W2 = W >> 1, H2 = H >> 1, h2 = new Float32Array(W2 * H2), hf = S.hf;
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++){
    const i = 2 * y * W + 2 * x;
    h2[y * W2 + x] = 0.25 * (hf[i] + hf[i + 1] + hf[i + W] + hf[i + W + 1]);
  }
  const XL2 = new Int32Array(W2), XR2 = new Int32Array(W2), XD2 = new Float32Array(W2);
  for (let x = 0; x < W2; x++){
    let l = (x + W2 - 1) % W2, r = (x + 1) % W2;
    if (strip(2 * l) !== strip(2 * x)) l = x;
    if (strip(2 * r) !== strip(2 * x)) r = x;
    XL2[x] = l; XR2[x] = r; XD2[x] = (l === x || r === x) ? 1 : 0.5;
  }
  const cN = normalCanvas(core, h2, W2, H2, 1.2, XL2, XR2, XD2);
  T.colour = now() - t;
  return {map: cC, normalMap: cN, roughnessMap: cR, timing: T};
}

/* ply pass 1: smooth ring phase (profile + meander + taper ramp + knot bumps), and the fibre field at full size */
function plyPhase(S){
  const W = S.W, H = S.H, PR = S.PR, WP = W * PR, PT0 = S.PT0, PT1 = S.PT1, MS0 = S.MS0, MS1 = S.MS1;
  const A0 = S.AMP[0], A1 = S.AMP[1], sb0 = S.sb0, sb1 = S.sb1, fibF = S.fibF, SW = S.SW, SH = S.SH;
  const bump = S.bump, P0 = S.P0, FB = S.FB;
  for (let y = 0; y < H; y++){
    const sy = y * SH / H, sy0 = sy | 0, sty = sy - sy0, sy1 = (sy0 + 1) % SH;
    const r0 = S.RAMP[0] * y / H + S.OFF[0], r1 = S.RAMP[1] * y / H + S.OFF[1];
    const m0 = MS0[y], m1 = MS1[y];
    for (let x = 0; x < W; x++){
      const i = y * W + x, s = x >= sb0 && x < sb1;
      let u = (x + (s ? m1 : m0)) * PR; u = u % WP; if (u < 0) u += WP;
      const j = u | 0, f = u - j, tab = s ? PT1 : PT0;
      const hv = tab[j] + (tab[j + 1] - tab[j]) * f;
      FB[i] = fibF[sy0 * SW + x] * (1 - sty) + fibF[sy1 * SW + x] * sty;
      P0[i] = hv * (s ? A1 : A0) + (s ? r1 : r0) + bump[i];
    }
  }
}

/* ply pass 2: fibre warp, scaled by the local ring density so it ragged-edges the bands but cannot streak the broad
   flat areas where the knife ran along one ring. Rows 0 and H-1 take their vertical neighbour across the V wrap,
   where the taper ramp jumps by a whole number of rings (RX); that jump is taken out of the slope. */
function plyWarp(S){
  const W = S.W, H = S.H, P0 = S.P0, FB = S.FB, PH = S.PH, XL = S.XL, XR = S.XR, XD = S.XD, RX = S.RX, WARP = S.WARP;
  for (let y = 0; y < H; y++){
    const yu = ((y - 1 + H) % H) * W, yd = ((y + 1) % H) * W, yr = y * W, jt = (y === 0 || y === H - 1) ? 1 : 0;
    for (let x = 0; x < W; x++){
      const i = yr + x;
      const gx = (P0[yr + XR[x]] - P0[yr + XL[x]]) * XD[x], gy = (P0[yd + x] - P0[yu + x] + jt * RX[x]) * 0.5;
      const g = Math.abs(gx) + Math.abs(gy);
      PH[i] = P0[i] + (FB[i] - 0.5) * WARP * clamp(g * 40 - 0.15, 0.06, 1);
    }
  }
}

/* ply pass 3: band profile with transition widths set in pixels (crisp ring boundary, short rise), then colour,
   roughness and height. dc32 / dr32 are RGBA words (little-endian) of the colour and roughness images. */
function plyColour(S, dc32, dr32){
  const W = S.W, H = S.H, P0 = S.P0, PH = S.PH, FB = S.FB, hf = S.hf, XL = S.XL, XR = S.XR, XD = S.XD, RX = S.RX;
  const sb0 = S.sb0, sb1 = S.sb1, RLA0 = S.RLA0, RLA1 = S.RLA1, RDK0 = S.RDK0, RDK1 = S.RDK1, n0 = RLA0.length, n1 = RLA1.length;
  const knotD = S.knotD, patchE = S.patchE, patchK = S.patchK, patches = S.patches, mot = S.mot, MW = S.MW, MH = S.MH;
  const e0 = S.early[0], e1 = S.early[1], e2 = S.early[2], l0 = S.late[0] - e0, l1 = S.late[1] - e1, l2 = S.late[2] - e2;
  const mrow = new Float32Array(MW + 1), MX0 = new Int32Array(W), MXT = new Float32Array(W);
  for (let x = 0; x < W; x++){ const mx = x * MW / W; MX0[x] = mx | 0; MXT[x] = mx - (mx | 0); }
  for (let y = 0; y < H; y++){
    const yu = ((y - 1 + H) % H) * W, yd = ((y + 1) % H) * W, yr = y * W, jt = (y === 0 || y === H - 1) ? 1 : 0;
    const my = y * MH / H, my0 = my | 0, mty = my - my0, my1 = (my0 + 1) % MH;
    for (let j = 0; j < MW; j++) mrow[j] = mot[my0 * MW + j] * (1 - mty) + mot[my1 * MW + j] * mty;
    mrow[MW] = mrow[0];
    for (let x = 0; x < W; x++){
      const i = yr + x, s = x >= sb0 && x < sb1;
      const ph = PH[i], fb = FB[i];
      const iR = yr + XR[x], iL = yr + XL[x], xd = XD[x], jy = jt * RX[x];
      const gx = (PH[iR] - PH[iL]) * xd, gy = (PH[yd + x] - PH[yu + x] + jy) * 0.5, hx = (P0[iR] - P0[iL]) * xd, hy = (P0[yd + x] - P0[yu + x] + jy) * 0.5;
      /* the sharp ring boundary is antialiased to ~1 px of the warped phase; the earlywood->latewood rise is a few px
         of the smooth phase, so the fibre warp cannot spread it into streaks */
      const g = Math.sqrt(gx * gx + gy * gy), g0 = Math.sqrt(hx * hx + hy * hy);
      const wr = clamp(g0 * 2, 0.008, 0.12), wb = clamp(g * 0.9, 0.003, 0.3);
      const k = Math.floor(ph) | 0, nk = s ? n1 : n0, kk = ((k % nk) + nk) % nk;
      const p = s ? ph - k : 1 - (ph - k), la = s ? RLA1[kk] : RLA0[kk];
      let lw = sstep(la - wr, la + wr, p) * (1 - sstep(1 - 2 * wb, 1, p));
      lw *= (0.88 + 0.12 * clamp((p - la) / (1 - la), 0, 1)) * (s ? RDK1[kk] : RDK0[kk]);
      const mx0 = MX0[x], mv = mrow[mx0] + (mrow[mx0 + 1] - mrow[mx0]) * MXT[x];
      let rough, hgt = 0.5 + 0.05 * lw + 0.03 * (fb - 0.5), tone = s ? 1.02 : 0.99, line = 0, synth = false;
      const ds = Math.min(Math.abs(x + 0.5 - sb0), Math.abs(x + 0.5 - sb1));
      if (ds < 1) line = 0.07 * (1 - ds);
      const pk = patchK[i];
      if (pk >= 0){
        const pt = patches[pk], e = patchE[i];
        if (e < -0.5){
          if (pt.synth) synth = true;
          else {
            /* inset veneer: straight, close grain, visibly paler than the face around it */
            const pp = (x - pt.x) * 0.16 + (fb - 0.5) * 0.5 + pt.ph, q = pp - Math.floor(pp);
            lw = sstep(0.72, 0.84, q) * (1 - sstep(0.93, 0.97, q)) * 0.4; tone = 1.07;
          }
        }
        /* crisp glue line round the patch */
        const ln = 1 - Math.abs(e + 0.1) * 1.4;
        if (ln > 0){ line = Math.max(line, (pt.synth ? 0.18 : 0.3) * ln); hgt -= 0.06 * ln; }
      }
      let r, g2, b;
      if (synth){
        /* filled synthetic patch: flat grey-yellow putty, no grain, smoother, sitting a touch low */
        const n = 1 + (fb - 0.5) * 0.02 + (mv - 0.5) * 0.02;
        r = 190 * n; g2 = 178 * n; b = 150 * n; rough = 0.55; hgt = 0.47;
      } else {
        const L = lw * 0.85, f = (1 + (fb - 0.5) * 0.09) * tone * (0.95 + 0.1 * mv);
        r = (e0 + l0 * L) * f; g2 = (e1 + l1 * L) * f; b = (e2 + l2 * L) * f;
        const kd = knotD[i] * 0.65;
        if (kd > 0.001){ r = r * (1 - kd) + 92 * kd; g2 = g2 * (1 - kd) + 60 * kd; b = b * (1 - kd) + 36 * kd; }
        rough = 0.8 - 0.1 * lw + (fb - 0.5) * 0.06;
      }
      const lf = 1 - line, rv = (rough * 255 + 0.5) | 0;
      dc32[i] = (255 << 24) | (clamp(b * lf * 0.98 + 0.5, 0, 255) << 16) | (clamp(g2 * lf + 0.5, 0, 255) << 8) | clamp(r * lf + 0.5, 0, 255);
      dr32[i] = (255 << 24) | (rv << 16) | (rv << 8) | rv;
      hf[i] = hgt;
    }
  }
}

/* Cut edges: on any box face whose smaller side is under 0.1 ft (the sheet's thickness), replace the squeezed face
   texture with an edge pattern across the thickness. Chained after core.worldUV's patch. kind 0 = OSB, 1 = ply. */
function edgePatch(m, kind){
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = function(shader, renderer){
    if (prev) prev.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vShEdge;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vShEdge = vec3(0.0);
        #ifdef USE_INSTANCING
        {
          vec3 eS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vec3 eN = abs(normal);
          vec2 eD = eN.x > 0.5 ? vec2(eS.z, eS.y) : (eN.y > 0.5 ? vec2(eS.x, eS.z) : vec2(eS.x, eS.y));
          bool thinU = eD.x < eD.y;
          if (min(eD.x, eD.y) < 0.1) vShEdge = vec3(1.0, thinU ? uv.x : uv.y,
            (thinU ? uv.y * eD.y : uv.x * eD.x) + dot(instanceMatrix[3].xyz, vec3(0.37, 0.71, 0.53)));
        }
        #endif`);
    const col = kind === 0 ? `
        /* OSB cut edge: dense compressed strands, darker than the face, fine layering along the edge */
        float lay = shN(e.x * 13.0 + shN(e.y * 5.0) * 2.5);
        float mot = shN(e.y * 19.0 + e.x * 3.0) * 0.6 + shN(e.y * 67.0) * 0.4;
        vec3 c = mix(vec3(0.21, 0.12, 0.05), vec3(0.36, 0.23, 0.11), lay * 0.55 + mot * 0.45);` : `
        /* ply edge: five plies, long grain (pale) alternating with end grain (darker), thin dark glue lines */
        float k = e.x * 5.0, pl = floor(k), f = fract(k);
        vec3 c = mix(vec3(0.50, 0.37, 0.21), vec3(0.32, 0.21, 0.11), mod(pl, 2.0));
        c *= 0.9 + 0.2 * shN(e.y * 37.0 + pl * 7.0);
        float gl = (1.0 - smoothstep(0.0, 0.07, min(f, 1.0 - f))) * step(0.5, k) * step(k, 4.5);
        c = mix(c, vec3(0.12, 0.08, 0.04), gl * 0.7);`;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vShEdge;
        float shH(float n){ return fract(sin(n) * 43758.5453); }
        float shN(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(shH(i), shH(i + 1.0), f); }
        vec3 shEdgeCol(vec2 e){ ${col}
          return c; }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        if (vShEdge.x > 0.5) diffuseColor.rgb = diffuse * shEdgeCol(vShEdge.yz);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        if (vShEdge.x > 0.5) roughnessFactor = 0.88;`)
      .replace("#include <normal_fragment_maps>", `vec3 shN0 = normal;
        #include <normal_fragment_maps>
        if (vShEdge.x > 0.5) normal = shN0;`);
  };
  const prevKey = m.customProgramCacheKey;
  m.customProgramCacheKey = function(){ return (prevKey ? prevKey.call(this) : "") + "|shEdge" + kind; };
  m.needsUpdate = true;
  return m;
}

/* one material over shared textures (so osb and osbWall upload their maps once) */
function makeMaterial(THREE, core, tex, o){
  const m = new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 1, metalness: 0});
  m.map = tex.map; m.normalMap = tex.normalMap; m.roughnessMap = tex.roughnessMap;
  m.normalScale = new THREE.Vector2(o.normalScale, o.normalScale);
  core.worldUV(m, {tile: o.tile, grain: o.grain, jitter: 1});
  return edgePatch(m, o.kind);
}
function textures(THREE, core, c){
  return {map: core.texture(THREE, c.map, {srgb: true}), normalMap: core.texture(THREE, c.normalMap), roughnessMap: core.texture(THREE, c.roughnessMap)};
}

/* canvases are built once per page and shared by every create() call; ply only when first asked for */
let osbCanvas = null, plyCanvas = null;
REAL.sheet = {
  timing: {},
  create: function(THREE, renderer, opts){
    const core = REAL.core;
    if (!osbCanvas){
      const t0 = now();
      osbCanvas = buildOSB(core);
      REAL.sheet.timing.osb = now() - t0;
      REAL.sheet.timing.osbSteps = osbCanvas.timing;
    }
    const ot = textures(THREE, core, osbCanvas);
    /* Roughness lives in the maps (material roughness 1 = map value). The OSB tile is 4 ft square, so the grain
       mode only decides which way the strands run:
       osb      grain "long": strands follow each piece's own long side. Right for full 4x8 sheets whichever way they
                lie (subfloor, roof deck, sheets on a wall); a cut piece whose long side differs from its parent
                sheet's (a 4x2 over a window, a 1.5 ft rip) turns its strands 90 degrees.
       osbWall  grain "none": on vertical faces strands always run vertically, whatever the cut size. Use it for wall
                sheathing hung vertically (the usual way here); for a wall of sheets laid horizontally use osb. */
    const osb = makeMaterial(THREE, core, ot, {tile: [4, 4], grain: "long", normalScale: 1.0, kind: 0});
    const osbWall = makeMaterial(THREE, core, ot, {tile: [4, 4], grain: "none", normalScale: 1.0, kind: 0});
    let ply = null;
    const variants = {
      /* oriented strand board: subfloor, roof deck, full wall sheets. tile 4 ft square (repeats twice along an 8 ft sheet) */
      osb: {material: osb, sample: [4, 8, 0.06], count: 3, spread: [4.02, 0, 0]},
      /* the same board for wall sheathing cut to any size: strands stay vertical */
      osbWall: {material: osbWall, sample: [4, 8, 0.06], count: 2, spread: [4.02, 0, 0]},
      /* sanded softwood plywood face, one tile = one 4 x 8 sheet (a sheet never repeats within itself). Built on first
         read of variants.ply, so the subfloor alternate costs nothing unless it is used. */
      get ply(){
        if (!ply){
          if (!plyCanvas){
            const t0 = now();
            plyCanvas = buildPly(core);
            REAL.sheet.timing.ply = now() - t0;
            REAL.sheet.timing.plySteps = plyCanvas.timing;
          }
          ply = {material: makeMaterial(THREE, core, textures(THREE, core, plyCanvas), {tile: [4, 8], grain: "long", normalScale: 0.6, kind: 1}),
                 sample: [8, 0.06, 4], count: 2, spread: [0, 0, 4.02]};
        }
        return ply;
      }
    };
    return {variants};
  }
};
})();
