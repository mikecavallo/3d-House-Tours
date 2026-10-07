/* REAL.veg: procedural photoreal trees and shrubs for the build hero (three.js r128, plain script, feet, y up).

   REAL.veg.create(THREE, renderer, opts) -> {
     types:   ["pine","hemlock","oak","shrub","maple","rose","hydrangea"],
     samples: [{type, size, seed, label, footprint}],     one per type (footprint = measured crown width, ft)
     make(type, size, seed, o) -> THREE.Group            base at the origin, top at `size` ft (within ~2%).
                                                         o: {density} overrides opts.density for this plant
                                                         (e.g. 0.4-0.6 for backdrop trees).
                                                         Children: "wood" (bark tubes, Mesh) + "foliage" (alpha-tested
                                                         cards, Mesh with customDepthMaterial/customDistanceMaterial):
                                                         2 draw calls per plant. group.userData.triangles is set.
     batch(list, o) -> THREE.Group                       many plants merged into one mesh per material (bark + up to three
                                                         foliage atlases), i.e. <= 4 draw calls for the whole planting.
                                                         Items: {type, size, seed, x, y, z, rot (yaw, radians), scale,
                                                                 density, order (0..1, reveal order)}
                                                         o: {reveal: true, window: 0.12} gives the batch its own material
                                                         clones with a grow-in uniform: group.userData.setReveal(v), v 0..1;
                                                         a plant grows from its base while v passes order..order+window
                                                         (default order = index spread over 0..1-window). Shadows follow.
     materials: {bark, conifer, broadleaf, flower},      shared by every plant (make() and non-reveal batches)
     triangles(object3D) -> number,  buildMs, timing,  atlases (the painted canvases and per-cell crop, for inspection)
   }
   opts: { density: 1 (foliage card multiplier), dirAO: 0.5 (how much crown occlusion also dims direct sun inside the
           shadow frustum; outside it, it is full) }

   Typical sizes (ft): pine 40-60, hemlock 25-40, oak 35-50, shrub 3-5, maple (lace-leaf) 4-6, rose (of sharon) 7-9,
   hydrangea 3-4. The "oak" type is a generic hardwood: by seed it carries lobed oak or palmate maple leaves.

   Technique
   - Three 1024x1024 foliage atlases are painted with canvas-2D vector shapes: white-pine needle tufts, hemlock sprays,
     oak and maple leaf clusters, azalea/boxwood rosettes, dissected lace-leaf maple sprays, rose of sharon (leaves +
     flowers, leaves + buds, single flowers), hydrangea leaves and mophead flowers. Each atlas has an sRGB colour map, a
     separate alpha map and a painted normal map in which every leaf half carries its own tilt (midrib fold). After
     painting, each cell's painted bounds are measured once from the alpha canvas and every card is cropped to them
     (same geometry, far fewer transparent fragments).
   - Bark is two tileable height fields computed per pixel (oak/hemlock: long interlacing ridges with near-black furrows
     and sparse cross-breaks; white pine: broad flat grey scaly plates), from which colour and normal maps are derived.
     A per-vertex bark kind picks one in the shader, so wood stays one draw call.
   - Plants are tapered bark tubes (parallel-transport frames, root-flare lobes, branch collars sunk into the parent,
     capped blunt dead stubs) plus many randomly oriented foliage cards. Card vertex normals are bent toward the outside
     of their clump / crown so canopies shade as volumes; a per-vertex "leafAO" darkens the crown interior.
   - Foliage uses alpha-to-coverage with an alpha sharpened to one pixel (fwidth), so card edges are antialiased by MSAA
     and do not crawl; alpha is boosted with mip level so foliage does not thin out with distance; cards seen edge-on
     fade out. The shadow depth materials use the same alpha at a 0.5 cutoff, so foliage casts dappled shadows.
   All deterministic per (type, size, seed): REAL.core.rng with fixed seeds, never Math.random. */
(function(){
"use strict";
const REAL = window.REAL = window.REAL || {};
const TAU = Math.PI * 2;
const AT = 1024, MARGIN = 4;                 /* atlas size, crop margin in px */
const BARK_U = 1.3, BARK_V = 2.6;            /* feet per bark repeat around / along a limb */

/* ------------------------------------------------------------------ math */
function clamp(x, a, b){ return x < a ? a : x > b ? b : x; }
function sstep(a, b, x){ const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function lerp(a, b, t){ return a + (b - a) * t; }
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const mad = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = a => Math.hypot(a[0], a[1], a[2]);
const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const UP = [0, 1, 0];
function perp(d){ return nrm(cross(d, Math.abs(d[1]) < 0.92 ? UP : [1, 0, 0])); }
function rotate(v, k, a){
  const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}
function sph(r){ const z = r() * 2 - 1, a = r() * TAU, s = Math.sqrt(1 - z * z); return [s * Math.cos(a), z, s * Math.sin(a)]; }
function inBall(r){ for (;;){ const q = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]; if (dot(q, q) <= 1) return q; } }
function dirAE(az, el){ const c = Math.cos(el); return [c * Math.cos(az), Math.sin(el), c * Math.sin(az)]; }
function hashStr(s){ let h = 2166136261; for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/* polyline walker: n steps of L/n from p along d, f(t, d) bends the direction */
function grow(p, d, L, n, f){
  const pts = [p]; let q = p, dd = nrm(d);
  for (let i = 1; i <= n; i++){ if (f) dd = nrm(f(i / n, dd)); q = mad(q, dd, L / n); pts.push(q); }
  return pts;
}
/* arc-length sampler over a 3-D polyline: s in 0..1 -> {p, d} */
function along3(pts){
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + vlen(sub(pts[i], pts[i - 1])));
  const tot = cum[cum.length - 1] || 1;
  const f = function(s){
    const L = clamp(s, 0, 1) * tot; let i = 0;
    while (i < pts.length - 2 && cum[i + 1] < L) i++;
    const seg = cum[i + 1] - cum[i] || 1, t = (L - cum[i]) / seg;
    return {p: vlerp(pts[i], pts[i + 1], t), d: nrm(sub(pts[i + 1], pts[i]))};
  };
  f.total = tot;
  return f;
}
/* radii along a limb by arc length: r0 -> r1, optionally with a branch collar (1.3x over the first ~10%) */
function limbRadii(pts, r0, r1, collar){
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + vlen(sub(pts[i], pts[i - 1])));
  const tot = cum[cum.length - 1] || 1;
  return cum.map(c => { const f = c / tot; return lerp(r0, r1, f) * (collar ? 1 + 0.3 * (1 - sstep(0, 0.12, f)) : 1); });
}
/* split the first segment so a collar has a vertex to live on */
function withCollar(pts){ return [pts[0], vlerp(pts[0], pts[1], 0.45)].concat(pts.slice(1)); }
/* ray from o along d to the inside surface of an ellipsoid (c, r) */
function roomTo(o, d, c, r){
  const oo = [(o[0] - c[0]) / r[0], (o[1] - c[1]) / r[1], (o[2] - c[2]) / r[2]];
  const dd = [d[0] / r[0], d[1] / r[1], d[2] / r[2]];
  const a = dot(dd, dd), b = 2 * dot(oo, dd), cc = dot(oo, oo) - 1, disc = b * b - 4 * a * cc;
  if (disc < 0) return 0;
  return Math.max(0, (-b + Math.sqrt(disc)) / (2 * a));
}
function ellDist(p, c, r){ return Math.hypot((p[0] - c[0]) / r[0], (p[1] - c[1]) / r[1], (p[2] - c[2]) / r[2]); }

/* ------------------------------------------------------------------ geometry builder */
function Builder(wood){
  this.P = []; this.N = []; this.T = []; this.C = []; this.A = []; this.K = []; this.O = []; this.I = []; this.n = 0;
  this.wood = !!wood; this.floor = -Infinity;
}
Builder.prototype.v = function(p, n, u, v, c, a, k){
  this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]); this.T.push(u, v); this.C.push(c[0], c[1], c[2]); this.A.push(a);
  if (this.wood) this.K.push(k || 0);
  return this.n++;
};
/* tapered tube through pts with radii rad (parallel-transport frames). o: {kind (bark 0 ridged / 1 plates),
   flare(i, angle) -> radius multiplier, cap (close the tip: blunt stubs)} */
Builder.prototype.tube = function(pts, rad, segs, tint, aoFn, o){
  const n = pts.length; if (n < 2) return;
  o = o || {};
  const kind = o.kind || 0, flare = o.flare;
  const base = this.n, rep = Math.max(1, Math.round(TAU * rad[0] / BARK_U));
  let N = null, vl = 0, t = null;
  for (let i = 0; i < n; i++){
    t = nrm(sub(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]));
    if (!N) N = perp(t);
    else { N = sub(N, mul(t, dot(N, t))); const l = vlen(N); N = l > 1e-4 ? mul(N, 1 / l) : perp(t); }
    const B = cross(t, N);
    if (i) vl += vlen(sub(pts[i], pts[i - 1]));
    const ao = aoFn ? aoFn(pts[i]) : 1;
    for (let j = 0; j <= segs; j++){
      const a = j / segs * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const d = [N[0] * ca + B[0] * sa, N[1] * ca + B[1] * sa, N[2] * ca + B[2] * sa];
      this.v(mad(pts[i], d, rad[i] * (flare ? flare(i, a) : 1)), d, j / segs * rep, vl / BARK_V, tint, ao, kind);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < segs; j++){
    const a = base + i * (segs + 1) + j, b = a + segs + 1;
    this.I.push(a, a + 1, b, a + 1, b + 1, b);
  }
  if (o.cap){
    const last = pts[n - 1], rr = rad[n - 1];
    const c = this.v(mad(last, t, rr * 0.3), t, rep * 0.5, vl / BARK_V + 0.05, tint, aoFn ? aoFn(last) : 1, kind);
    const r0 = base + (n - 1) * (segs + 1);
    for (let j = 0; j < segs; j++) this.I.push(c, r0 + j, r0 + j + 1);
  }
};
/* one foliage card. p = attach point, up = texture V axis (twig base -> tip), face ~ card normal,
   w/h = size of the FULL atlas cell in feet, anchor = fraction of h the base sits behind p,
   fr = cell frame (uv + cropped extent, see frames()), vc/vr = ellipsoid whose outward gradient bends the vertex normals
   (volume shading), bend 0..1. Returns the card basis {b, R, up, F, w, h} so painted features can be located. */
Builder.prototype.card = function(p, up, face, w, h, anchor, fr, tint, ao, vc, vr, bend, aoFn){
  let R = cross(up, face);
  if (vlen(R) < 1e-3) R = perp(up);
  R = nrm(R);
  let F = cross(R, up);
  let b = mad(p, up, -h * anchor);
  const corner = (X, Y) => [b[0] + R[0] * w * (X - 0.5) + up[0] * h * Y, b[1] + R[1] * w * (X - 0.5) + up[1] * h * Y, b[2] + R[2] * w * (X - 0.5) + up[2] * h * Y];
  let cs = [corner(fr.X0, fr.H0), corner(fr.X1, fr.H0), corner(fr.X1, fr.H1), corner(fr.X0, fr.H1)];
  if (this.floor > -1e9){
    let mn = Math.min(cs[0][1], cs[1][1], cs[2][1], cs[3][1]);
    if (mn < this.floor){
      /* turn a card that would dip into the ground upward, then lift it if it still does */
      up = nrm([up[0], Math.abs(up[1]) + 0.25, up[2]]);
      R = cross(up, face); if (vlen(R) < 1e-3) R = perp(up); R = nrm(R); F = cross(R, up);
      b = mad(p, up, -h * anchor);
      cs = [corner(fr.X0, fr.H0), corner(fr.X1, fr.H0), corner(fr.X1, fr.H1), corner(fr.X0, fr.H1)];
      mn = Math.min(cs[0][1], cs[1][1], cs[2][1], cs[3][1]);
      if (mn < this.floor){ const dy = this.floor - mn; for (const c of cs) c[1] += dy; b = [b[0], b[1] + dy, b[2]]; }
    }
  }
  const us = [fr.u0, fr.u1, fr.u1, fr.u0], vs = [fr.vb, fr.vb, fr.vt, fr.vt];
  const base = this.n;
  for (let k = 0; k < 4; k++){
    const c = cs[k];
    const g = nrm([(c[0] - vc[0]) / (vr[0] * vr[0]), (c[1] - vc[1]) / (vr[1] * vr[1]), (c[2] - vc[2]) / (vr[2] * vr[2])]);
    const s = dot(F, g) < 0 ? -1 : 1;
    const n = nrm([F[0] * s * (1 - bend) + g[0] * bend, F[1] * s * (1 - bend) + g[1] * bend, F[2] * s * (1 - bend) + g[2] * bend]);
    this.v(c, n, us[k], vs[k], tint, clamp(ao * (aoFn ? aoFn(c) : 1), 0.12, 1.15), 0);
  }
  this.I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  return {b, R, up, F, w, h};
};
/* world position of a painted feature at cell coords (cx, cy) on a card made with frame fr */
function featPos(cb, fr, cx, cy){ const X = fr.m ? 1 - cx : cx; return add(mad(cb.b, cb.R, cb.w * (X - 0.5)), mul(cb.up, cb.h * (1 - cy))); }
/* append another builder, yawed (three.js rotation.y convention), scaled and translated; order != null records the
   plant origin + reveal order per vertex (vegPlant attribute) */
Builder.prototype.append = function(o, rot, s, t, order){
  const c = Math.cos(rot), sn = Math.sin(rot), off = this.n;
  for (let i = 0; i < o.n; i++){
    const x = o.P[i * 3] * s, y = o.P[i * 3 + 1] * s, z = o.P[i * 3 + 2] * s;
    this.P.push(x * c + z * sn + t[0], y + t[1], -x * sn + z * c + t[2]);
    const nx = o.N[i * 3], ny = o.N[i * 3 + 1], nz = o.N[i * 3 + 2];
    this.N.push(nx * c + nz * sn, ny, -nx * sn + nz * c);
    this.T.push(o.T[i * 2], o.T[i * 2 + 1]);
    this.C.push(o.C[i * 3], o.C[i * 3 + 1], o.C[i * 3 + 2]);
    this.A.push(o.A[i]);
    if (this.wood) this.K.push(o.K[i] || 0);
    if (order != null) this.O.push(t[0], t[1], t[2], order);
  }
  for (let i = 0; i < o.I.length; i++) this.I.push(o.I[i] + off);
  this.n += o.n;
};
Builder.prototype.maxY = function(){ let m = -Infinity; for (let i = 1; i < this.P.length; i += 3) if (this.P[i] > m) m = this.P[i]; return m; };
Builder.prototype.scale = function(s){ for (let i = 0; i < this.P.length; i++) this.P[i] *= s; };
Builder.prototype.geometry = function(THREE){
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(this.P, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(this.N, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(this.T, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(this.C, 3));
  g.setAttribute("leafAO", new THREE.Float32BufferAttribute(this.A, 1));
  if (this.wood) g.setAttribute("vegK", new THREE.Float32BufferAttribute(this.K, 1));
  if (this.O.length) g.setAttribute("vegPlant", new THREE.Float32BufferAttribute(this.O, 4));
  g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
};

/* ------------------------------------------------------------------ texture painting */
function rgbs(c, a){ return a == null ? "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")" : "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a + ")"; }
function mixc(a, b, t){ return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function jit(c, r, amt, hue){ const k = 1 + (r() - 0.5) * 2 * amt, h = (r() - 0.5) * 2 * (hue || 0); return [clamp(c[0] * k * (1 + h), 0, 255), clamp(c[1] * k, 0, 255), clamp(c[2] * k * (1 - h), 0, 255)]; }
/* canvas-space normal (x right, y down, z out of the canvas) -> tangent-space normal map colour (green = +V = canvas up) */
function nstyle(nx, ny, nz){
  const l = Math.hypot(nx, ny, nz) || 1;
  return "rgb(" + Math.round((nx / l * 0.5 + 0.5) * 255) + "," + Math.round((-ny / l * 0.5 + 0.5) * 255) + "," + Math.round((nz / l * 0.5 + 0.5) * 255) + ")";
}
const FLATN = "rgb(128,128,255)";

/* 2-D helpers for painters (cell units 0..1, y down) */
function walk(r, x, y, ang, L, n, curl, wob){
  const pts = [[x, y]], st = L / n, w = wob == null ? 0.1 : wob;
  for (let i = 0; i < n; i++){ ang += curl + (r() - 0.5) * w; x += Math.cos(ang) * st; y += Math.sin(ang) * st; pts.push([x, y]); }
  return pts;
}
function along2(pts){
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const tot = cum[cum.length - 1] || 1;
  const f = function(s){
    const L = clamp(s, 0, 1) * tot; let i = 0;
    while (i < pts.length - 2 && cum[i + 1] < L) i++;
    const seg = cum[i + 1] - cum[i] || 1, t = (L - cum[i]) / seg;
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], dl = Math.hypot(dx, dy) || 1;
    return {x: pts[i][0] + dx * t, y: pts[i][1] + dy * t, dx: dx / dl, dy: dy / dl, a: Math.atan2(dy, dx)};
  };
  f.length2 = tot;
  return f;
}
/* leaf outline in leaf-local space (base at 0, axis +x): top (y<0) and bottom halves, base -> tip */
function outline(len, wid, hw, n, r, asym){
  const top = [], bot = [], ph = r() * TAU, a = asym == null ? 0.08 : asym;
  for (let i = 0; i <= n; i++){
    const t = i / n, h = hw(t) * wid, k = a * Math.sin(t * 4 + ph);
    top.push([t * len, -h * (1 + k)]); bot.push([t * len, h * (1 - k)]);
  }
  return {top, bot, len, wid};
}
const ellip = (p, q) => t => Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(t, p))), q);
const serr = (base, teeth, depth) => t => base(t) * (1 + depth * (((t * teeth) % 1) - 0.5) * sstep(0.04, 0.2, t) * (1 - sstep(0.86, 1, t)));
const oakShape = t => ellip(1.15, 0.7)(t) * (1 - 0.55 * Math.pow(0.5 + 0.5 * Math.cos(TAU * (t * 4.5 - 0.15)), 3) * sstep(0.1, 0.25, t) * (1 - sstep(0.82, 0.97, t)));

/* a cell: the three atlas contexts clipped + scaled to one square cell, painted in cell units */
function Cell(ctxs, ox, oy, size){
  this.c = ctxs[0]; this.a = ctxs[1]; this.n = ctxs[2]; this.all = ctxs;
  for (const x of ctxs){ x.save(); x.beginPath(); x.rect(ox, oy, size, size); x.clip(); x.translate(ox, oy); x.scale(size, size); x.lineCap = "round"; x.lineJoin = "round"; }
}
Cell.prototype.end = function(){ for (const x of this.all) x.restore(); };
Cell.prototype.twig = function(pts, w0, w1, col){
  const n = pts.length - 1, cs = rgbs(col);
  for (let i = 0; i < n; i++){
    const w = lerp(w0, w1, i / Math.max(1, n - 1));
    const p = new Path2D(); p.moveTo(pts[i][0], pts[i][1]); p.lineTo(pts[i + 1][0], pts[i + 1][1]);
    this.a.lineWidth = this.c.lineWidth = this.n.lineWidth = w;
    this.a.strokeStyle = "#fff"; this.a.stroke(p);
    this.c.strokeStyle = cs; this.c.stroke(p);
    this.n.strokeStyle = FLATN; this.n.stroke(p);
  }
};
/* many quadratic strokes [x0,y0,cx,cy,x1,y1] in one colour (needles, dissected lobes) */
Cell.prototype.strokes = function(segs, width, col, ns){
  if (!segs.length) return;
  const p = new Path2D();
  for (const s of segs){ p.moveTo(s[0], s[1]); p.quadraticCurveTo(s[2], s[3], s[4], s[5]); }
  this.a.lineWidth = this.c.lineWidth = this.n.lineWidth = width;
  this.a.strokeStyle = "#fff"; this.a.stroke(p);
  this.c.strokeStyle = rgbs(col); this.c.stroke(p);
  this.n.strokeStyle = ns; this.n.stroke(p);
};
/* one leaf (or petal / sepal / lobe). o: {fold, tilt:[tx,ty], rib, veins, shade, ribCol} */
Cell.prototype.leaf = function(x, y, ang, L, col, o){
  o = o || {};
  const top = L.top, bot = L.bot, c = this.c, a = this.a, n = this.n;
  const full = new Path2D();
  full.moveTo(top[0][0], top[0][1]);
  for (let i = 1; i < top.length; i++) full.lineTo(top[i][0], top[i][1]);
  for (let i = bot.length - 1; i >= 0; i--) full.lineTo(bot[i][0], bot[i][1]);
  full.closePath();
  for (const x2 of this.all){ x2.save(); x2.translate(x, y); x2.rotate(ang); }
  a.fillStyle = "#fff"; a.fill(full);
  c.fillStyle = rgbs(col); c.fill(full);
  const sh = o.shade == null ? 1 : o.shade;
  if (sh){
    const g = c.createLinearGradient(0, -L.wid, 0, L.wid);
    g.addColorStop(0, "rgba(255,250,215," + (0.13 * sh).toFixed(3) + ")");
    g.addColorStop(0.5, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0," + (0.16 * sh).toFixed(3) + ")");
    c.fillStyle = g; c.fill(full);
    const g2 = c.createLinearGradient(0, 0, L.len, 0);
    g2.addColorStop(0, "rgba(0,0,0," + (0.12 * sh).toFixed(3) + ")");
    g2.addColorStop(0.35, "rgba(0,0,0,0)");
    g2.addColorStop(1, "rgba(255,255,220," + (0.06 * sh).toFixed(3) + ")");
    c.fillStyle = g2; c.fill(full);
  }
  if (o.rib){
    const rc = o.ribCol || mixc(col, [225, 235, 190], 0.28);
    c.strokeStyle = rgbs(rc, 0.6); c.lineWidth = Math.max(0.0022, L.wid * 0.07);
    c.beginPath(); c.moveTo(0, 0); c.lineTo(L.len * 0.93, 0); c.stroke();
    if (o.veins){
      c.lineWidth = Math.max(0.0016, L.wid * 0.035); c.strokeStyle = rgbs(rc, 0.35);
      c.beginPath();
      const nt = top.length - 1;
      for (let k = 0; k < o.veins; k++){
        const t = (k + 0.8) / (o.veins + 0.6) * 0.86, i = Math.min(nt, Math.round((t + 0.12) * nt));
        const x0 = t * L.len;
        c.moveTo(x0, 0); c.quadraticCurveTo(x0 + L.len * 0.05, top[i][1] * 0.5, top[i][0], top[i][1] * 0.85);
        c.moveTo(x0, 0); c.quadraticCurveTo(x0 + L.len * 0.05, bot[i][1] * 0.5, bot[i][0], bot[i][1] * 0.85);
      }
      c.stroke();
    }
  }
  /* normal map: each half tilted toward (or away from) the midrib, on top of the leaf's own tilt */
  const ca = Math.cos(ang), sa = Math.sin(ang), lx = -sa, ly = ca;
  const t = o.tilt || [0, 0], f = o.fold == null ? 0.3 : o.fold;
  const half = pts => { const p = new Path2D(); p.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]); p.lineTo(L.len, 0); p.lineTo(0, 0); p.closePath(); return p; };
  n.fillStyle = nstyle(t[0] + lx * f, t[1] + ly * f, 1); n.fill(half(top));
  n.fillStyle = nstyle(t[0] - lx * f, t[1] - ly * f, 1); n.fill(half(bot));
  for (const x2 of this.all) x2.restore();
};
/* colour-only radial wash (flower eyes, shading) */
Cell.prototype.wash = function(x, y, rad, inner, outer){
  const g = this.c.createRadialGradient(x, y, 0, x, y, rad);
  g.addColorStop(0, inner); g.addColorStop(1, outer);
  this.c.fillStyle = g; this.c.beginPath(); this.c.arc(x, y, rad, 0, TAU); this.c.fill();
};

/* ---- painters: each is {bg, paint(cell, rnd), meta} ---- */
function tiltR(r, a){ return [(r() - 0.5) * 2 * a, (r() - 0.5) * 2 * a]; }

/* eastern white pine: soft 5-needle fascicles along a twig, a brush-like tuft at the tip */
function pinePainter(variant){
  return {bg: [64, 92, 62], paint(cell, r){
    const twigs = [];
    if (variant === 0){
      twigs.push({pts: walk(r, 0.5, 0.99, -Math.PI / 2 + (r() - 0.5) * 0.12, 0.6, 8, (r() - 0.5) * 0.03, 0.06), sc: 1});
    } else {
      const m = walk(r, 0.5, 0.99, -Math.PI / 2 + 0.04, 0.3, 4, 0, 0.05), e = m[m.length - 1];
      twigs.push({pts: m, sc: 0.75, from: 0.3});
      twigs.push({pts: walk(r, e[0], e[1], -Math.PI / 2 - 0.55, 0.4, 6, 0.035, 0.06), sc: 0.8});
      twigs.push({pts: walk(r, e[0], e[1], -Math.PI / 2 + 0.5, 0.36, 6, -0.035, 0.06), sc: 0.8});
    }
    const NB = 8, B = []; for (let i = 0; i < NB; i++) B.push([]);
    for (const tw of twigs){
      const f = along2(tw.pts);
      for (let s = tw.from || 0.12; s <= 1.0001; s += 0.02){
        const q = f(s);
        for (let k = 0; k < 5; k++){
          const side = r() < 0.5 ? -1 : 1;
          const spread = (0.28 + 0.95 * r()) * (1 - 0.45 * s);
          const a = q.a + side * spread, L = (0.12 + 0.11 * r()) * tw.sc * (0.8 + 0.25 * s);
          const ex = q.x + Math.cos(a) * L, ey = q.y + Math.sin(a) * L, bend = (r() - 0.25) * 0.22 * L * side;
          const mx = q.x + Math.cos(a) * L * 0.5 - Math.sin(a) * bend, my = q.y + Math.sin(a) * L * 0.5 + Math.cos(a) * bend;
          B[(r() * NB) | 0].push([q.x, q.y, mx, my, ex, ey]);
        }
      }
      const e = f(1);
      for (let k = 0; k < 46; k++){
        const a = e.a + (r() - 0.5) * 1.9, L = (0.09 + 0.1 * r()) * tw.sc;
        const ex = e.x + Math.cos(a) * L, ey = e.y + Math.sin(a) * L, bend = (r() - 0.5) * 0.15 * L;
        B[(NB * (0.35 + 0.65 * r())) | 0].push([e.x, e.y, (e.x + ex) / 2 - Math.sin(a) * bend, (e.y + ey) / 2 + Math.cos(a) * bend, ex, ey]);
      }
    }
    for (const tw of twigs) cell.twig(tw.pts, 0.012 * tw.sc, 0.005, [96, 82, 62]);
    const dark = [58, 88, 60], light = [128, 156, 104];
    for (let b = 0; b < NB; b++){
      const t = b / (NB - 1);
      cell.strokes(B[b], 0.0034, jit(mixc(dark, light, t), r, 0.05, 0.05), nstyle((r() - 0.5) * 0.9, (r() - 0.5) * 0.9, 1));
    }
  }};
}

/* eastern hemlock: flat pinnate spray, two-ranked short flat needles, light yellow-green new growth at the tips */
function hemlockPainter(variant){
  return {bg: [68, 92, 44], paint(cell, r){
    const axes = [];
    const main = walk(r, 0.5 + (r() - 0.5) * 0.06, 0.985, -Math.PI / 2 + (r() - 0.5) * 0.18, 0.9, 10, (r() - 0.5) * 0.035, 0.05);
    axes.push({pts: main, w: 0.0065});
    const fm = along2(main);
    let side = r() < 0.5 ? -1 : 1;
    const maxL = variant ? 0.3 : 0.36;
    for (let s = 0.06; s < 0.93; s += 0.055 + r() * 0.025){
      side = -side;
      const q = fm(s);
      const L = maxL * Math.pow(1 - s, 0.7) * (0.75 + 0.5 * r()) + 0.03;
      const sp = walk(r, q.x, q.y, q.a + side * (0.95 + r() * 0.3), L, 5, -side * 0.035, 0.08);
      axes.push({pts: sp, w: 0.004});
      if (L > 0.12){
        const fs = along2(sp); let s2 = side;
        for (let t = 0.28; t < 0.85; t += 0.2 + r() * 0.08){
          s2 = -s2; const q2 = fs(t);
          axes.push({pts: walk(r, q2.x, q2.y, q2.a + s2 * 1.0, L * (1 - t) * 0.5 + 0.02, 3, 0, 0.1), w: 0.003});
        }
      }
    }
    const NB = 6, B = [], G = [[], []]; for (let i = 0; i < NB; i++) B.push([]);
    for (const ax of axes){
      const f = along2(ax.pts), tot = f.length2, step = 0.0085 / tot;
      for (let s = 0; s <= 1; s += step){
        const q = f(s);
        for (const sd of [-1, 1]){
          const a = q.a + sd * (1.2 + (r() - 0.5) * 0.4), L = (0.021 + r() * 0.011) * (1 - 0.35 * s);
          const ex = q.x + Math.cos(a) * L, ey = q.y + Math.sin(a) * L;
          const seg = [q.x, q.y, (q.x + ex) / 2, (q.y + ey) / 2, ex, ey];
          if (s > 0.55 && r() < 0.85) G[(r() * 2) | 0].push(seg); else B[(r() * NB) | 0].push(seg);
        }
        if (r() < 0.25){ const a = q.a + (r() - 0.5) * 0.6, L = 0.016; B[(r() * NB) | 0].push([q.x, q.y, q.x + Math.cos(a) * L * 0.5, q.y + Math.sin(a) * L * 0.5, q.x + Math.cos(a) * L, q.y + Math.sin(a) * L]); }
      }
    }
    for (const ax of axes) cell.twig(ax.pts, ax.w, ax.w * 0.6, [92, 72, 50]);
    const dark = [62, 85, 38], light = [112, 133, 60];
    for (let b = 0; b < NB; b++) cell.strokes(B[b], 0.0046, jit(mixc(dark, light, b / (NB - 1)), r, 0.05, 0.04), nstyle((r() - 0.5) * 0.8, (r() - 0.5) * 0.8, 1));
    cell.strokes(G[0], 0.0046, [136, 158, 72], nstyle(0.2, -0.2, 1));
    cell.strokes(G[1], 0.0046, [150, 170, 82], nstyle(-0.25, 0.1, 1));
  }};
}

/* hardwood twig cluster: oak (lobed) or maple (palmate) leaves, whorled at the twig tips */
function broadleafPainter(kind){
  return {bg: kind === "oak" ? [44, 68, 38] : [46, 72, 38], paint(cell, r){
    const main = walk(r, 0.5, 0.99, -Math.PI / 2, 0.22, 3, 0, 0.08), fork = main[main.length - 1];
    const twigs = [main], tips = [];
    const nT = 4;
    for (let k = 0; k < nT; k++){
      const a = -Math.PI / 2 + (k - (nT - 1) / 2) * 0.62 + (r() - 0.5) * 0.2;
      const tw = walk(r, fork[0], fork[1], a, 0.3 + r() * 0.12, 4, (r() - 0.5) * 0.1, 0.12);
      twigs.push(tw); tips.push({p: tw[tw.length - 1], a: a, f: along2(tw)});
    }
    const leaves = [];
    for (const tp of tips){
      const n = 5 + ((r() * 3) | 0);
      for (let j = 0; j < n; j++) leaves.push({x: tp.p[0], y: tp.p[1], a: tp.a + (j / (n - 1) - 0.5) * 2.9 + (r() - 0.5) * 0.3, d: 0.3 + r() * 0.7, s: 0.8 + r() * 0.25});
      for (let j = 0; j < 3; j++){
        const q = tp.f(0.25 + r() * 0.55);
        leaves.push({x: q.x, y: q.y, a: q.a + (j % 2 ? 1 : -1) * (0.7 + r() * 0.6), d: r() * 0.8, s: 0.7 + r() * 0.2});
      }
    }
    leaves.sort((p, q) => p.d - q.d);
    for (const tw of twigs) cell.twig(tw, 0.008, 0.0035, [88, 74, 56]);
    const dark = kind === "oak" ? [38, 62, 34] : [40, 66, 34], light = kind === "oak" ? [74, 108, 52] : [78, 112, 54];
    for (const lf of leaves){
      const col = jit(mixc(dark, light, clamp(lf.d * 0.75 + r() * 0.3, 0, 1)), r, 0.07, 0.04);
      const off = 0.014;
      const x = lf.x + Math.cos(lf.a) * off, y = lf.y + Math.sin(lf.a) * off;
      if (kind === "oak"){
        const L = (0.15 + 0.05 * r()) * lf.s;
        cell.leaf(x, y, lf.a, outline(L, L * 0.34, oakShape, 56, r, 0.1), col, {fold: 0.25 + r() * 0.3, tilt: tiltR(r, 0.35), rib: true, veins: 4});
      } else {
        const R = (0.1 + 0.035 * r()) * lf.s, la = [0, 0.78, -0.78, 1.5, -1.5], ll = [1, 0.86, 0.86, 0.5, 0.5];
        const tilt = tiltR(r, 0.3);
        for (let k = 4; k >= 0; k--){
          const L = R * ll[k];
          cell.leaf(x, y, lf.a + la[k] + (r() - 0.5) * 0.12, outline(L, L * 0.42, serr(ellip(0.72, 0.85), 5, 0.55), 30, r, 0.06), col, {fold: 0.2, tilt: [tilt[0] + (r() - 0.5) * 0.2, tilt[1] + (r() - 0.5) * 0.2], rib: true, veins: 0, shade: 0.7});
        }
      }
    }
  }};
}

/* azalea / boxwood: dense rosettes of small glossy leaves */
function shrubPainter(){
  return {bg: [52, 70, 30], paint(cell, r){
    const leaves = [];
    for (let k = 0; k < 8; k++){
      const cx = 0.5 + (r() - 0.5) * 0.56, cy = 0.2 + 0.62 * r(), n = 5 + ((r() * 3) | 0), a0 = r() * TAU, d = r();
      for (let j = 0; j < n; j++) leaves.push({x: cx, y: cy, a: a0 + j * TAU / n + (r() - 0.5) * 0.4, d: d + 0.15 * r(), L: 0.11 + 0.05 * r()});
    }
    for (let k = 0; k < 26; k++) leaves.push({x: 0.18 + 0.64 * r(), y: 0.12 + 0.76 * r(), a: r() * TAU, d: r() * 0.7, L: 0.1 + 0.05 * r()});
    leaves.sort((p, q) => p.d - q.d);
    const dark = [48, 74, 32], light = [92, 120, 50];
    for (const lf of leaves){
      const col = jit(mixc(dark, light, clamp(lf.d * 0.8 + r() * 0.25, 0, 1)), r, 0.06, 0.06);
      cell.leaf(lf.x, lf.y, lf.a, outline(lf.L, lf.L * 0.36, ellip(0.92, 0.75), 20, r, 0.05), col, {fold: 0.35, tilt: tiltR(r, 0.45), rib: true, shade: 0.9});
    }
  }};
}

/* lace-leaf Japanese maple ('Dissectum'): a hanging spray of finely dissected palmate leaves. Bronze-maroon with
   olive-tan sunlit leaves and a few bright red ones at the tips. Each lobe is a thread-like blade with 2-3 side
   segments, so the leaf reads as lace rather than a star. */
function lacePainter(){
  const dark = [74, 40, 40], light = [128, 98, 80], olive = [130, 118, 78], red = [192, 60, 48];
  return {bg: [80, 42, 44], paint(cell, r){
    const tw = walk(r, 0.5, 0.99, -Math.PI / 2 + (r() - 0.5) * 0.1, 0.88, 8, (r() - 0.5) * 0.04, 0.08), f = along2(tw);
    const leaves = [];
    let side = 1;
    for (let s = 0.08; s < 0.98; s += 0.07 + r() * 0.03){
      side = -side;
      const q = f(s), pa = q.a + side * (0.75 + r() * 0.6), pl = 0.035 + r() * 0.04;
      leaves.push({x: q.x + Math.cos(pa) * pl, y: q.y + Math.sin(pa) * pl, a: pa + (r() - 0.5) * 0.6, d: r(), R: 0.12 + 0.06 * r(), px: q.x, py: q.y, s});
    }
    leaves.sort((p, q) => p.d - q.d);
    cell.twig(tw, 0.008, 0.004, [74, 40, 36]);
    for (const lf of leaves){
      cell.twig([[lf.px, lf.py], [lf.x, lf.y]], 0.003, 0.003, [96, 46, 40]);
      const u = r();
      let base;
      if (lf.s > 0.72 && u < 0.22) base = red;
      else if (u > 0.81 - 0.08 * lf.s) base = olive;
      else base = mixc(dark, light, clamp(lf.d * 0.75 + r() * 0.3, 0, 1));
      base = jit(base, r, 0.07, 0.04);
      const nl = 7 + ((r() * 3) | 0), fan = 4.2, tilt = tiltR(r, 0.35), subs = [];
      for (let k = 0; k < nl; k++){
        const t = k / (nl - 1) - 0.5, L = lf.R * (1 - 0.4 * t * t * 4) * (0.8 + 0.3 * r());
        const a = lf.a + t * fan + (r() - 0.5) * 0.2 + (r() - 0.5) * 0.3;
        cell.leaf(lf.x, lf.y, a, outline(L, L * 0.07, serr(ellip(0.8, 0.9), 7, 0.6), 28, r, 0.08), jit(base, r, 0.06, 0.03), {fold: 0.35, tilt: [tilt[0] + (r() - 0.5) * 0.35, tilt[1] + (r() - 0.5) * 0.35], shade: 0.4});
        const ns = 2 + (r() < 0.5 ? 1 : 0);
        for (let j = 0; j < ns; j++){
          const tt = 0.3 + j * 0.2 + r() * 0.08, sd = (j + k) % 2 ? 1 : -1;
          const bx = lf.x + Math.cos(a) * L * tt, by = lf.y + Math.sin(a) * L * tt;
          const ba = a + sd * (0.55 + r() * 0.3), bl = L * (0.17 + r() * 0.12);
          const ex = bx + Math.cos(ba) * bl, ey = by + Math.sin(ba) * bl;
          subs.push([bx, by, (bx + ex) / 2 + Math.cos(a) * bl * 0.15, (by + ey) / 2 + Math.sin(a) * bl * 0.15, ex, ey]);
        }
      }
      cell.strokes(subs, lf.R * 0.05, jit(base, r, 0.05, 0.02), nstyle(tilt[0], tilt[1], 1));
    }
  }};
}

/* rose of sharon: toothed 3-lobed leaves; variant 0 adds two open pink-magenta flowers with a dark red eye (their
   positions are exported in meta.flowers for the cupped flower cards), variant 1 buds */
function rosePainter(variant){
  const pt = {bg: [46, 68, 32], meta: {flowers: []}, paint(cell, r){
    const tw = walk(r, 0.5, 0.99, -Math.PI / 2 + (r() - 0.5) * 0.1, 0.84, 7, (r() - 0.5) * 0.03, 0.08), f = along2(tw);
    cell.twig(tw, 0.009, 0.004, [96, 86, 66]);
    const leaves = []; let side = 1;
    for (let s = 0.1; s < 0.98; s += 0.1 + r() * 0.04){ side = -side; const q = f(s); leaves.push({x: q.x, y: q.y, a: q.a + side * (0.7 + r() * 0.45), d: r(), L: (0.16 + 0.07 * r()) * (1 - 0.3 * s)}); }
    leaves.sort((p, q) => p.d - q.d);
    const dark = [50, 76, 34], light = [100, 130, 54];
    const rshape = t => serr(ellip(0.82, 0.85), 8, 0.4)(t) * (1 + 0.22 * Math.exp(-Math.pow((t - 0.45) / 0.1, 2)));
    for (const lf of leaves) cell.leaf(lf.x, lf.y, lf.a, outline(lf.L, lf.L * 0.42, rshape, 40, r, 0.1), jit(mixc(dark, light, clamp(lf.d * 0.8 + r() * 0.25, 0, 1)), r, 0.06, 0.05), {fold: 0.35, tilt: tiltR(r, 0.35), rib: true, veins: 3});
    if (variant === 0){
      const fl = [{x: 0.3 + r() * 0.08, y: 0.3 + r() * 0.1}, {x: 0.64 + r() * 0.08, y: 0.5 + r() * 0.12}];
      for (const F of fl){
        const R = 0.14 + 0.03 * r();
        paintFlower(cell, r, F.x, F.y, R, [214, 92, 160]);
        pt.meta.flowers.push({x: F.x, y: F.y, R});
      }
    } else {
      for (let k = 0; k < 4; k++){
        const q = f(0.35 + k * 0.17), a = q.a + (k % 2 ? 1 : -1) * 0.5;
        const L = 0.05 + r() * 0.02, x = q.x + Math.cos(a) * 0.01, y = q.y + Math.sin(a) * 0.01;
        cell.leaf(x, y, a, outline(L, L * 0.38, ellip(1.0, 0.8), 16, r, 0.05), k % 2 ? [92, 116, 52] : [176, 92, 140], {fold: 0.3, tilt: tiltR(r, 0.3), shade: 0.8});
      }
    }
  }};
  return pt;
}
/* a five-petal hibiscus flower with a dark red eye and a pale stamen column */
function paintFlower(cell, r, x, y, R, col){
  const a0 = r() * TAU, base = jit(col, r, 0.06, 0.04);
  for (let k = 0; k < 5; k++){
    const a = a0 + k * TAU / 5 + (r() - 0.5) * 0.25;
    cell.leaf(x, y, a, outline(R, R * 0.52, ellip(1.7, 0.6), 26, r, 0.12), jit(base, r, 0.06, 0.02), {fold: 0.14, tilt: [-Math.cos(a) * 0.4, -Math.sin(a) * 0.4], rib: true, ribCol: [170, 50, 110], veins: 3, shade: 0.6});
  }
  cell.wash(x, y, R * 0.42, "rgba(118,8,52,0.95)", "rgba(150,20,80,0)");
  const sa = r() * TAU, sl = R * 0.32;
  cell.twig([[x, y], [x + Math.cos(sa) * sl, y + Math.sin(sa) * sl]], R * 0.055, R * 0.04, [236, 226, 196]);
  cell.wash(x + Math.cos(sa) * sl, y + Math.sin(sa) * sl, R * 0.11, "rgba(244,232,170,1)", "rgba(244,232,170,0.2)");
}
/* a single rose of sharon flower filling its cell (for the cupped flower cards) */
function roseFlowerPainter(variant){
  return {bg: [196, 92, 150], paint(cell, r){ paintFlower(cell, r, 0.5, 0.5, 0.46, variant ? [226, 124, 176] : [210, 86, 156]); }};
}

/* hydrangea: big opposite serrated leaves */
function hydLeafPainter(){
  return {bg: [50, 76, 34], paint(cell, r){
    const tw = walk(r, 0.5, 0.99, -Math.PI / 2, 0.8, 6, 0, 0.06), f = along2(tw);
    cell.twig(tw, 0.012, 0.006, [96, 104, 62]);
    const leaves = [];
    [0.18, 0.46, 0.72, 0.92].forEach((s, i) => {
      const q = f(s), sz = i === 3 ? 0.55 : 1 - i * 0.12;
      for (const sd of [-1, 1]) leaves.push({x: q.x, y: q.y, a: q.a + sd * (0.75 + r() * 0.4), d: r(), L: (0.3 + 0.06 * r()) * sz});
    });
    leaves.sort((p, q) => p.d - q.d);
    const dark = [54, 86, 38], light = [108, 144, 60];
    for (const lf of leaves) cell.leaf(lf.x, lf.y, lf.a, outline(lf.L, lf.L * 0.36, serr(ellip(0.9, 0.8), 13, 0.16), 60, r, 0.06), jit(mixc(dark, light, clamp(lf.d * 0.8 + r() * 0.2, 0, 1)), r, 0.05, 0.04), {fold: 0.3, tilt: tiltR(r, 0.3), rib: true, veins: 6});
  }};
}

/* hydrangea mophead: a ball of four-sepal florets, sphere-shaded in both colour and normal map */
function hydFlowerPainter(pal, bg){
  return {bg, paint(cell, r){
    const cx = 0.5, cy = 0.5, R = 0.45, fl = [];
    for (let k = 0; k < 170; k++){ const rr = Math.sqrt(r()) * R * 0.97, a = r() * TAU; const dx = Math.cos(a) * rr, dy = Math.sin(a) * rr; fl.push({dx, dy, z: Math.sqrt(Math.max(0, R * R - rr * rr)) / R}); }
    fl.sort((p, q) => p.z - q.z);
    for (const F of fl){
      const base = jit(pal[(r() * pal.length) | 0], r, 0.05, 0.03);
      const sh = 0.78 + 0.22 * F.z + 0.08 * (-F.dx - F.dy) / R;
      const col = [base[0] * sh, base[1] * sh, base[2] * sh];
      const s = 0.05 + 0.016 * r(), a0 = r() * TAU, x = cx + F.dx, y = cy + F.dy;
      const tn = [F.dx / R * 0.9, F.dy / R * 0.9];
      for (let k = 0; k < 4; k++){
        const a = a0 + k * TAU / 4 + (r() - 0.5) * 0.3;
        cell.leaf(x, y, a, outline(s, s * 0.62, ellip(1.35, 0.6), 10, r, 0.1), jit(col, r, 0.04, 0.02), {fold: 0.1, tilt: [tn[0] - Math.cos(a) * 0.2, tn[1] - Math.sin(a) * 0.2], shade: 0});
      }
      cell.wash(x, y, s * 0.22, "rgba(70,80,130,0.8)", "rgba(70,80,130,0)");
    }
  }};
}

/* a canvas whose 2-D context is CPU-rasterised (willReadFrequently). Every canvas this module paints is one: thousands
   of small strokes draw faster in software than through the GPU canvas path (no per-path shader warm-up, no GPU
   start-up stalls), and read-backs / drawImage between them never need a GPU sync */
function cpuCanvas(core, w, h){ const c = core.canvas(w, h); c.getContext("2d", {willReadFrequently: true}); return c; }
function noiseCanvas(core, seed){
  const S = 128, f = core.normalize(core.fbm(S, S, {base: 4, octaves: 4, persistence: 0.55, seed: seed}));
  return core.paint(f, S, S, v => { const g = 128 + (v - 0.5) * 150; return [g, g, g]; }, cpuCanvas(core, S, S));
}

/* paint an atlas from [{p: painter, rect: [x, y, size]}]; measures each cell's painted bounds from the alpha canvas */
function paintAtlas(core, specs, seed){
  const col = cpuCanvas(core, AT, AT), alp = cpuCanvas(core, AT, AT), nor = cpuCanvas(core, AT, AT);
  const cc = col.getContext("2d"), ac = alp.getContext("2d"), nc = nor.getContext("2d");
  ac.fillStyle = "#000"; ac.fillRect(0, 0, AT, AT);
  nc.fillStyle = FLATN; nc.fillRect(0, 0, AT, AT);
  const noise = noiseCanvas(core, seed), cellMs = [];
  specs.forEach((sp, k) => {
    const tc = performance.now();
    const [ox, oy, cs] = sp.rect, pt = sp.p;
    cc.fillStyle = rgbs(pt.bg); cc.fillRect(ox, oy, cs, cs);
    const cell = new Cell([cc, ac, nc], ox, oy, cs);
    pt.paint(cell, core.rng(seed * 31 + k * 977 + 5));
    cell.end();
    cc.save(); cc.globalCompositeOperation = "soft-light"; cc.globalAlpha = 0.55;
    cc.drawImage(noise, ox, oy, cs, cs); cc.restore();
    cellMs.push(Math.round(performance.now() - tc));
  });
  /* painted bounds per cell (one read-back of the alpha canvas) */
  const d = ac.getImageData(0, 0, AT, AT).data;
  const cells = specs.map(sp => {
    const [ox, oy, cs] = sp.rect;
    let x0 = cs, x1 = -1, y0 = cs, y1 = -1;
    for (let y = 0; y < cs; y++){
      let row = ((oy + y) * AT + ox) * 4 + 1;
      for (let x = 0; x < cs; x++, row += 4) if (d[row] > 8){ if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    }
    if (x1 < 0){ x0 = 0; x1 = cs - 1; y0 = 0; y1 = cs - 1; }
    return {ox, oy, cs, x0: Math.max(1, x0 - MARGIN), x1: Math.min(cs - 1, x1 + 1 + MARGIN), y0: Math.max(1, y0 - MARGIN), y1: Math.min(cs - 1, y1 + 1 + MARGIN), meta: sp.p.meta || null};
  });
  /* card frames: uv rectangle + the cropped extent as fractions of the full cell (X across, H up from the base) */
  const frames = cells.map(c => {
    const ua = (c.ox + c.x0) / AT, ub = (c.ox + c.x1) / AT, vb = 1 - (c.oy + c.y1) / AT, vt = 1 - (c.oy + c.y0) / AT;
    const fx0 = c.x0 / c.cs, fx1 = c.x1 / c.cs, H0 = 1 - c.y1 / c.cs, H1 = 1 - c.y0 / c.cs;
    return [{u0: ua, u1: ub, vb, vt, X0: fx0, X1: fx1, H0, H1, m: false}, {u0: ub, u1: ua, vb, vt, X0: 1 - fx1, X1: 1 - fx0, H0, H1, m: true}];
  });
  const fill = cells.map(c => +(((c.x1 - c.x0) * (c.y1 - c.y0)) / (c.cs * c.cs)).toFixed(2));
  return {col, alp, nor, cells, frames, fill, cellMs};
}
const GRID4 = [[0, 0, 512], [512, 0, 512], [0, 512, 512], [512, 512, 512]];

/* ------------------------------------------------------------------ bark
   Two tileable 256x512 height fields (one repeat = BARK_U x BARK_V feet), computed per pixel:
   kind 0 (oak / hemlock / shrubs): ~10 long ridges per repeat whose furrows wander and cross (interlacing), sparse
            shallow cross-breaks, near-black furrows, grey ridge tops, a little grey-green lichen;
   kind 1 (white pine): 6 broad flat plates per repeat, broken into scales by frequent deep cross-cracks, grey with
            warmer red-brown furrows.
   Colour and normal maps are both derived from the height. */
function paintBark(core, kind){
  const BW = 256, BH = 512, r = core.rng(kind ? 9191 : 4242);
  const NF = kind ? 6 : 10, sp = BW / NF;
  const fur = [];
  for (let i = 0; i < NF; i++){
    const hs = [];
    for (let j = 0; j < 3; j++) hs.push({k: 1 + j + ((r() * 2) | 0), a: sp * (kind ? 0.16 : 0.34) * (0.5 + r()) / (j + 1), ph: r() * TAU});
    const ws = [{k: 1 + ((r() * 2) | 0), a: 0.35, ph: r() * TAU}, {k: 3 + ((r() * 4) | 0), a: 0.25, ph: r() * TAU}];
    fur.push({x0: (i + 0.5 + (r() - 0.5) * 0.4) * sp, hs, ws, w0: sp * (kind ? 0.11 : 0.2) * (0.8 + 0.4 * r())});
  }
  const FX = new Float32Array(NF * BH), FW = new Float32Array(NF * BH);
  for (let i = 0; i < NF; i++){
    const f = fur[i];
    for (let y = 0; y < BH; y++){
      let x = f.x0, w = 1;
      for (const h of f.hs) x += h.a * Math.sin(TAU * h.k * y / BH + h.ph);
      for (const h of f.ws) w += h.a * Math.sin(TAU * h.k * y / BH + h.ph);
      FX[i * BH + y] = x; FW[i * BH + y] = f.w0 * Math.max(0.3, w);
    }
  }
  /* cross-breaks per ridge (ridge i lies right of furrow i): periodic in y */
  const brk = [];
  for (let i = 0; i < NF; i++){
    const list = []; let y = r() * BH;
    const y1 = y + BH;
    while (y < y1){
      list.push({y: y % BH, slope: (r() - 0.5) * (kind ? 0.5 : 0.8), w: kind ? 1.6 + r() * 1.6 : 1.2 + r() * 1.4, depth: kind ? 0.75 + r() * 0.2 : 0.35 + r() * 0.35});
      y += kind ? 22 + r() * 40 : 70 + r() * 140;
    }
    brk.push(list);
  }
  const nfine = core.fbm(BW, BH, {base: 8, octaves: 3, sx: 1, sy: 2, persistence: 0.6, seed: kind ? 31 : 17});
  const nstr = core.fbm(BW, BH, {base: 4, octaves: 3, sx: 8, sy: 1, persistence: 0.55, seed: kind ? 32 : 18});
  const nlow = core.normalize(core.fbm(BW, BH, {base: 2, octaves: 3, sx: 1, sy: 2, persistence: 0.5, seed: kind ? 33 : 19}));
  const H = new Float32Array(BW * BH), tone = new Float32Array(BW * BH);
  for (let y = 0; y < BH; y++){
    for (let x = 0; x < BW; x++){
      let best = 1e9, bi = 0, bdx = 0;
      for (let i = 0; i < NF; i++){
        let dx = x - FX[i * BH + y]; dx -= BW * Math.round(dx / BW);
        const u = Math.abs(dx) / FW[i * BH + y];
        if (u < best){ best = u; bi = i; bdx = dx; }
      }
      let h = kind ? sstep(0.45, 1.5, best) : Math.pow(sstep(0.4, 2.1, best), 0.75);
      const rid = bdx >= 0 ? bi : (bi + NF - 1) % NF;
      const lx = bdx >= 0 ? bdx : bdx + sp;
      let seg = 0;
      for (const b of brk[rid]){
        let dy = y - b.y - b.slope * lx; dy -= BH * Math.round(dy / BH);
        const ad = Math.abs(dy);
        if (ad < b.w * 2.5) h *= 1 - b.depth * (1 - sstep(0, b.w, ad));
        if (dy > 0) seg++;
      }
      const i = y * BW + x;
      h = h * (0.82 + 0.18 * nfine[i]) + (nstr[i] - 0.5) * 0.12;
      H[i] = h;
      tone[i] = (((rid * 7 + seg * 13) % 11) / 11 - 0.5) * (kind ? 0.16 : 0.1);
    }
  }
  const furrowC = kind ? [46, 36, 31] : [28, 23, 20], ridgeC = kind ? [128, 126, 121] : [116, 110, 102];
  const lichenC = [138, 142, 124];
  /* colour and normal written straight into ImageData (no per-pixel allocations: this runs over 2 x 131k pixels) */
  const col = cpuCanvas(core, BW, BH), nmc = cpuCanvas(core, BW, BH);
  const cctx = col.getContext("2d"), nctx = nmc.getContext("2d");
  const ci = cctx.createImageData(BW, BH), ni = nctx.createImageData(BW, BH), cd = ci.data, nd = ni.data;
  const gam = kind ? 1.1 : 1.3, ns = (kind ? 4.5 : 5.5) * 0.5;
  for (let y = 0; y < BH; y++){
    const yu = (y - 1 + BH) % BH, yd = (y + 1) % BH;
    for (let x = 0; x < BW; x++){
      const i = y * BW + x, o = i * 4, lo = nlow[i], h = H[i];
      const t = clamp(h, 0, 1), k = (0.86 + 0.28 * lo + tone[i]) * (0.9 + 0.2 * nfine[i]), m = Math.pow(t, gam);
      let r0 = furrowC[0] + (ridgeC[0] * k - furrowC[0]) * m, g0 = furrowC[1] + (ridgeC[1] * k - furrowC[1]) * m, b0 = furrowC[2] + (ridgeC[2] * k - furrowC[2]) * m;
      if (!kind){
        const li = sstep(0.8, 0.88, lo) * sstep(0.55, 0.85, t) * 0.4;
        if (li > 0){ r0 += (lichenC[0] - r0) * li; g0 += (lichenC[1] - g0) * li; b0 += (lichenC[2] - b0) * li; }
      } else {
        const pl = sstep(0.35, 0.7, t) * (1 - sstep(0.85, 1, t)) * 0.5;
        r0 *= 1 + 0.03 * pl; g0 *= 1 - 0.01 * pl; b0 *= 1 - 0.03 * pl;
      }
      cd[o] = r0; cd[o + 1] = g0; cd[o + 2] = b0; cd[o + 3] = 255;
      const dx = (H[y * BW + (x + 1) % BW] - H[y * BW + (x - 1 + BW) % BW]) * ns, dy = (H[yu * BW + x] - H[yd * BW + x]) * ns * 2;
      const il = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      nd[o] = (-dx * il * 0.5 + 0.5) * 255; nd[o + 1] = (-dy * il * 0.5 + 0.5) * 255; nd[o + 2] = (il * 0.5 + 0.5) * 255; nd[o + 3] = 255;
    }
  }
  cctx.putImageData(ci, 0, 0); nctx.putImageData(ni, 0, 0);
  return {col, nm: nmc};
}

/* ------------------------------------------------------------------ shaders */
/* alpha: boosted with mip level so foliage keeps its density in the distance; with VEG_A2C (main pass) sharpened to a
   one-pixel ramp for alpha-to-coverage, in the depth passes a plain 0.5 cutoff */
const ALPHA_CODE = `
#ifdef USE_ALPHAMAP
  vec2 vegG = vUv * ${AT.toFixed(1)};
  vec2 vegDx = dFdx( vegG ), vegDy = dFdy( vegG );
  float vegLod = max( 0.0, 0.5 * log2( max( dot( vegDx, vegDx ), dot( vegDy, vegDy ) ) ) );
  float vegA = texture2D( alphaMap, vUv ).g * ( 1.0 + vegLod * 0.3 );
  #ifdef VEG_A2C
    vegA = clamp( ( vegA - 0.5 ) / max( fwidth( vegA ), 1e-4 ) + 0.5, 0.0, 1.0 );
  #endif
  diffuseColor.a *= vegA;
#endif`;
/* cards seen nearly edge-on read as streaks: thin them out using the true (flat) face normal */
const EDGE_CODE = `
  vec3 vegFN = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
  diffuseColor.a *= smoothstep( 0.05, 0.3, abs( dot( vegFN, normalize( vViewPosition ) ) ) );`;
/* crown occlusion: always on ambient; on direct sun only partly where the shadow map already self-shadows the crown,
   fully outside the sun's shadow frustum (backdrop trees far from the house) */
const AO_CODE = `
  float vegIn = 0.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vec3 vegSC = vDirectionalShadowCoord[ 0 ].xyz / vDirectionalShadowCoord[ 0 ].w;
    vegIn = smoothstep( 0.0, 0.06, min( min( vegSC.x, 1.0 - vegSC.x ), min( vegSC.y, 1.0 - vegSC.y ) ) ) * step( vegSC.z, 1.0 );
  #endif
  float vegDA = mix( 1.0, vegDirAO, vegIn );
  float vegAOd = mix( vLeafAO * min( vLeafAO, 1.0 ), vLeafAO, vegIn );
  reflectedLight.indirectDiffuse *= vegAmb * vLeafAO * mix( vegBounce, vec3( 1.0 ), clamp( vLeafAO, 0.0, 1.0 ) );
  reflectedLight.indirectSpecular *= vLeafAO * vLeafAO * vegSpec;
  reflectedLight.directDiffuse *= mix( 1.0, vegAOd, vegDA );
  reflectedLight.directSpecular *= mix( 1.0, vegAOd, vegDA ) * vLeafAO * vegSpec;`;
const TRANS_CODE = `
void RE_Direct_Veg( const in IncidentLight directLight, const in GeometricContext geometry, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometry, material, reflectedLight );
  float vegBack = saturate( - dot( geometry.normal, directLight.direction ) );
  float vegFwd = pow( saturate( dot( geometry.viewDir, - directLight.direction ) ), 5.0 );
  vec3 vegTint = material.diffuseColor * vec3( 1.0, 1.12, 0.62 );
  reflectedLight.directDiffuse += directLight.color * vegTint * vegTrans * ( 0.4 * vegBack + 1.5 * vegFwd );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Veg`;
/* grow-in for reveal batches: every vertex is scaled toward its plant's base as the reveal value passes its order */
function revealVS(vs){
  return vs.replace("#include <common>", "#include <common>\nattribute vec4 vegPlant;\nuniform float vegReveal;\nuniform float vegRevealWin;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\n  float vegGr = clamp( ( vegReveal - vegPlant.w ) / vegRevealWin, 0.0, 1.0 );\n  vegGr = vegGr * vegGr * ( 3.0 - 2.0 * vegGr );\n  transformed = vegPlant.xyz + ( transformed - vegPlant.xyz ) * vegGr;");
}

/* o: {leaf, trans, dirAO, key, reveal: {u, w} | null, bark2: {map, nor} (bark only)} */
function patchMaterial(THREE, m, o){
  m.onBeforeCompile = function(sh){
    sh.uniforms.vegTrans = {value: o.trans};
    sh.uniforms.vegDirAO = {value: o.dirAO};
    sh.uniforms.vegSpec = {value: o.leaf ? 0.55 : 1.0};
    sh.uniforms.vegAmb = {value: o.leaf ? 1.6 : 1.15};
    sh.uniforms.vegBounce = {value: o.leaf ? new THREE.Vector3(1.12, 1.24, 0.8) : new THREE.Vector3(1.0, 1.05, 0.85)};
    let vs = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float leafAO;\nvarying float vLeafAO;" + (o.bark2 ? "\nattribute float vegK;\nvarying float vVegK;" : ""))
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLeafAO = leafAO;" + (o.bark2 ? "\nvVegK = vegK;" : ""));
    if (o.reveal){ sh.uniforms.vegReveal = o.reveal.u; sh.uniforms.vegRevealWin = o.reveal.w; vs = revealVS(vs); }
    sh.vertexShader = vs;
    let fs = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vLeafAO;\nuniform float vegTrans;\nuniform float vegDirAO;\nuniform float vegSpec;\nuniform vec3 vegBounce;\nuniform float vegAmb;")
      .replace("#include <aomap_fragment>", "#include <aomap_fragment>\n" + AO_CODE);
    if (o.leaf){
      fs = "#define VEG_A2C\n" + fs
        .replace("#include <map_fragment>", THREE.ShaderChunk.map_fragment.replace("texture2D( map, vUv )", "texture2D( map, vUv, - 0.5 )"))
        .replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin.replace("normal = normal * faceDirection;", ""))
        .replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps.replace("perturbNormal2Arb( -vViewPosition, normal, mapN, faceDirection )", "perturbNormal2Arb( -vViewPosition, normal, mapN, 1.0 )"))
        .replace("#include <alphamap_fragment>", ALPHA_CODE + EDGE_CODE)
        .replace("#include <lights_physical_pars_fragment>", "#include <lights_physical_pars_fragment>\n" + TRANS_CODE);
    }
    if (o.bark2){
      sh.uniforms.vegMap2 = {value: o.bark2.map}; sh.uniforms.vegNor2 = {value: o.bark2.nor};
      fs = fs.replace("#include <common>", "#include <common>\nuniform sampler2D vegMap2;\nuniform sampler2D vegNor2;\nvarying float vVegK;")
        .replace("#include <map_fragment>", THREE.ShaderChunk.map_fragment.replace("texture2D( map, vUv )", "mix( texture2D( map, vUv ), texture2D( vegMap2, vUv ), vVegK )"))
        .replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps.replace("texture2D( normalMap, vUv )", "mix( texture2D( normalMap, vUv ), texture2D( vegNor2, vUv ), vVegK )"));
    }
    sh.fragmentShader = fs;
  };
  const key = "veg-" + o.key + (o.reveal ? "-rv" : "");
  m.customProgramCacheKey = function(){ return key; };
  return m;
}
function patchDepth(m, key, reveal, alpha){
  m.onBeforeCompile = function(sh){
    if (reveal){ sh.uniforms.vegReveal = reveal.u; sh.uniforms.vegRevealWin = reveal.w; sh.vertexShader = revealVS(sh.vertexShader); }
    if (alpha) sh.fragmentShader = sh.fragmentShader.replace("#include <alphamap_fragment>", ALPHA_CODE);
  };
  const k = "vegd-" + key + (reveal ? "-rv" : "");
  m.customProgramCacheKey = function(){ return k; };
  m.extensions = {derivatives: true};
  return m;
}

/* ------------------------------------------------------------------ species */
const BARK = {
  pine: [0.92, 0.9, 0.88], dead: [1.32, 1.3, 1.28], hemlock: [0.9, 0.74, 0.66], oak: [0.95, 0.93, 0.9], shrub: [0.72, 0.66, 0.58],
  maple: [0.7, 0.55, 0.52], rose: [0.82, 0.8, 0.74], hydrangea: [0.74, 0.7, 0.58]
};
const ATLAS_OF = {pine: "conifer", hemlock: "conifer", oak: "broadleaf", shrub: "broadleaf", maple: "broadleaf", rose: "flower", hydrangea: "flower"};
const DEFAULT_SIZE = {pine: 52, hemlock: 32, oak: 44, shrub: 4, maple: 5, rose: 8, hydrangea: 3.5};

/* eastern white pine: tall clear trunk with root flare, blunt grey stubs and a few long dead silver limbs below the
   crown; irregular whorls of sinuous limbs (some forking) that sweep up at the tips, foliage in soft tufts */
function genPine(S, H, r){
  const W = S.wood, F = S.leaf, D = S.density;
  const R0 = H * (0.016 + r() * 0.004), lean = [(r() - 0.5) * 0.03, (r() - 0.5) * 0.03], ph = [r() * TAU, r() * TAU];
  const trunkAt = y => { const t = y / H; return [lean[0] * y + Math.sin(t * 4.5 + ph[0]) * 0.3 * t, y, lean[1] * y + Math.sin(t * 3.7 + ph[1]) * 0.3 * t]; };
  const radAt = y => Math.max(0.05, R0 * (1 - 0.88 * Math.pow(y / H, 0.85)) + R0 * 0.5 * Math.exp(-Math.max(0, y) / 0.9));
  const cb = H * (0.34 + r() * 0.1);
  const Lmax = H * (0.22 + r() * 0.05);
  const env = t => Math.pow(1 - t, 0.8) * (0.5 + 0.5 * sstep(0, 0.3, t)) + 0.05;
  const sp = [], rd = [], nS = Math.ceil(H / 1.5);
  sp.push(trunkAt(0)); rd.push(radAt(0));
  for (let i = 1; i <= nS; i++){ const y = Math.pow(i / nS, 1.25) * H * 0.985; sp.push(trunkAt(y)); rd.push(radAt(y)); }
  sp[0] = [sp[0][0], -0.4, sp[0][2]];
  const aoWood = p => p[1] < cb ? 0.9 : 0.55, fph = r() * TAU;
  W.tube(sp, rd, 12, BARK.pine, aoWood, {kind: 1, flare: (i, a) => 1 + 0.25 * Math.cos(5 * a + fph) * Math.exp(-Math.max(0, sp[i][1]) / 1.2)});
  /* blunt dead stubs */
  for (let y = 4 + r() * 3; y < cb + 2; y += 1.4 + r() * 2.2){
    const p0 = trunkAt(y), ry = radAt(y), d = dirAE(r() * TAU, -0.2 + r() * 0.35), L = 0.25 + r() * 0.8 * Math.min(1, y / cb + 0.3);
    const rr = Math.min(0.1, ry * 0.32);
    W.tube([mad(p0, d, ry * 0.4), mad(p0, d, ry + L * 0.5), mad(p0, d, ry + L)], [rr, rr * 0.9, rr * 0.7], 5, BARK.dead, () => 0.85, {kind: 1, cap: true});
  }
  /* long dead silver-grey limbs below the crown */
  const nDead = 2 + (r() < 0.5 ? 1 : 0);
  for (let k = 0; k < nDead; k++){
    const y = lerp(cb * 0.5, cb * 0.97, (k + r()) / nDead), p0 = trunkAt(y), ry = radAt(y);
    const d = dirAE(r() * TAU, -0.1 + r() * 0.4), L = 3 + r() * 5;
    const pts = withCollar(grow(mad(p0, d, ry * 0.4), d, L, 5, (s, dd) => add(dd, add([0, -0.05, 0], mul(sph(r), 0.1)))));
    W.tube(pts, limbRadii(pts, Math.min(0.17, ry * 0.32), 0.035, true), 5, BARK.dead, () => 0.85, {kind: 1, cap: true});
    const f = along3(pts), nt = 2 + ((r() * 3) | 0);
    for (let j = 0; j < nt; j++){
      const q = f(0.3 + r() * 0.65), td = nrm(add(rotate(q.d, UP, (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.6)), [0, 0.2 + r() * 0.4, 0]));
      W.tube(grow(q.p, td, 0.4 + r() * 1.3, 2, null), [0.035, 0.025, 0.018], 3, BARK.dead, () => 0.85, {kind: 1, cap: true});
    }
  }
  const pads = [];
  /* pads (foliage tufts) along a limb: branchlets alternate left/right, plus one at the tip */
  function limbPads(pts, L, t){
    const bf = along3(pts);
    let side = r() < 0.5 ? 1 : -1;
    for (let s = 0.34 + r() * 0.12; s < 0.95; s += (0.95 + r() * 0.6) / L){
      side = -side;
      const q = bf(s), hd = nrm([q.d[0], 0, q.d[2]]);
      const bd = nrm(add(rotate(hd, UP, side * (0.6 + r() * 0.5)), [0, 0.12 + r() * 0.2, 0]));
      const bl = Math.min(3.4, 0.8 + L * (1 - s) * (0.3 + 0.25 * r()));
      const bp = grow(q.p, bd, bl, 2, null);
      W.tube(bp, [0.04, 0.03, 0.015], 3, BARK.pine, () => 0.55, {kind: 1});
      pads.push({c: mad(bp[2], bd, -bl * 0.2), d: bd, pr: 0.95 + bl * 0.33 + r() * 0.35, t});
    }
    const tip = pts[pts.length - 1];
    pads.push({c: tip, d: nrm(sub(tip, pts[pts.length - 2])), pr: 1.3 + r() * 0.6, t});
  }
  let y = cb;
  while (y < H - 1.2){
    const t = (y - cb) / (H - cb), nb = 2 + ((r() * 3) | 0), az0 = r() * TAU;
    for (let k = 0; k < nb; k++){
      if (r() < 0.12 + 0.25 * (1 - t)) continue;
      const az = az0 + k * TAU / nb + (r() - 0.5) * 0.9;
      let L = Lmax * env(t) * (0.6 + 0.65 * r());
      if (r() < 0.14 && t < 0.6) L *= 1.35;
      L = Math.max(L, 1.3);
      const el0 = lerp(-0.2, 0.5, t) + (r() - 0.5) * 0.5, p0 = trunkAt(y), ry = radAt(y), d0 = dirAE(az, el0);
      const pts = withCollar(grow(mad(p0, d0, -ry * 0.5), d0, L + ry * 0.5, 6, (s, d) => add(d, add([0, s < 0.55 ? -0.07 * (1 - t) : 0.13, 0], mul(sph(r), 0.2)))));
      const rb = clamp(0.07 + L * 0.02, 0.07, ry * 0.55);
      W.tube(pts, limbRadii(pts, rb, rb * 0.3, true), 6, BARK.pine, aoWood, {kind: 1});
      limbPads(pts, L, t);
      if (L > 5 && r() < 0.45){
        const f = along3(pts), q = f(0.4 + r() * 0.2), fd = nrm(add(rotate(q.d, UP, (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.4)), [0, 0.08, 0]));
        const fl = L * (0.4 + r() * 0.2);
        const fp = withCollar(grow(q.p, fd, fl, 4, (s, d) => add(d, add([0, 0.08, 0], mul(sph(r), 0.12)))));
        W.tube(fp, limbRadii(fp, rb * 0.55, rb * 0.2, true), 4, BARK.pine, aoWood, {kind: 1});
        limbPads(fp, fl, t);
      }
    }
    y += 1.4 + r() * 1.5;
  }
  const top = trunkAt(H * 0.985);
  pads.push({c: add(top, [0, 0.2, 0]), d: UP, pr: 1.2, t: 1});
  pads.push({c: add(top, [0, -1.0, 0]), d: UP, pr: 1.5, t: 1});
  for (const pd of pads){
    const n = Math.max(3, Math.round((2 + pd.pr * pd.pr * 3.0) * D));
    const k = 0.9 + r() * 0.2, hue = (r() - 0.5) * 0.1, tint = [k * (1 + hue), k, k * (1 - hue)];
    const ty = pd.t, ctr = trunkAt(pd.c[1]);
    const rel = Math.hypot(pd.c[0] - ctr[0], pd.c[2] - ctr[2]) / (Lmax * env(clamp(ty, 0, 1)) + 1.5);
    const ao = lerp(0.6, 1.0, sstep(0.05, 0.85, rel)) * lerp(0.9, 1.05, ty);
    const vc = [pd.c[0], pd.c[1] - pd.pr * 0.55, pd.c[2]], vr = [pd.pr * 1.3, pd.pr * 1.0, pd.pr * 1.3];
    const cy = pd.c[1], pr = pd.pr;
    const aoFn = v => clamp(0.8 + 0.5 * (v[1] - cy) / pr, 0.6, 1.12);
    for (let i = 0; i < n; i++){
      const q = inBall(r), p = [pd.c[0] + q[0] * pr, pd.c[1] + q[1] * pr * 0.5, pd.c[2] + q[2] * pr];
      const up = nrm(add(add(pd.d, mul(sph(r), 0.9)), [0, 0.45, 0]));
      const face = nrm(add(sph(r), [0, 0.35, 0]));
      const sz = 2.0 + r() * 1.0;
      F.card(p, up, face, sz, sz, 0.3, S.fr(r() < 0.55 ? 0 : 1, r), tint, ao, vc, vr, 0.6, aoFn);
    }
  }
}

/* eastern hemlock: soft, lacy cone of slender limbs that arch out and droop at the tips, to near the ground; irregular
   spacing and lengths (skipped whorls) for a ragged outline; nodding leader */
function genHemlock(S, H, r){
  const W = S.wood, F = S.leaf, D = S.density;
  F.floor = 0.1;
  const R0 = H * (0.017 + r() * 0.003), ph = [r() * TAU, r() * TAU], nodAz = r() * TAU;
  const trunkAt = y => {
    const t = y / H, nod = Math.max(0, y - (H - 2.6)) / 2.6;
    return [Math.sin(t * 3.1 + ph[0]) * 0.2 * t + Math.cos(nodAz) * nod * nod * 1.1, y - nod * nod * 0.5, Math.sin(t * 2.7 + ph[1]) * 0.2 * t + Math.sin(nodAz) * nod * nod * 1.1];
  };
  const radAt = y => Math.max(0.03, R0 * (1 - 0.95 * Math.pow(y / H, 0.9)) + R0 * 0.45 * Math.exp(-Math.max(0, y) / 0.8));
  const sp = [], rd = [], nS = Math.ceil(H / 1.2);
  for (let i = 0; i <= nS; i++){ const y = i / nS * H; sp.push(trunkAt(y)); rd.push(radAt(y)); }
  sp[0] = [sp[0][0], -0.4, sp[0][2]];
  const fph = r() * TAU;
  W.tube(sp, rd, 9, BARK.hemlock, p => lerp(0.55, 0.8, p[1] / H), {kind: 0, flare: (i, a) => 1 + 0.22 * Math.cos(5 * a + fph) * Math.exp(-Math.max(0, sp[i][1]) / 1.0)});
  const Lmax = H * (0.23 + r() * 0.05);
  const env = t => Math.pow(1 - t, 0.95) * (0.82 + 0.18 * sstep(0, 0.12, t)) + 0.05;
  const vc = [0, H * 0.3, 0], vr = [Lmax * 1.1, H * 0.62, Lmax * 1.1];
  let y = 0.7 + r() * 0.6, az = r() * TAU;
  while (y < H - 0.6){
    const t = y / H;
    az += 2.4 + (r() - 0.5) * 1.3;
    if (r() < 0.16){ y += 0.3 + r() * 0.5; continue; }
    const L = Lmax * env(t) * (0.5 + 0.9 * r()) + 0.6;
    const el0 = lerp(0.05, 0.6, t) + (r() - 0.5) * 0.4, p0 = trunkAt(y), ry = radAt(y), d0 = dirAE(az, el0);
    const dr = Math.min(1, y / 7);   /* low limbs droop less: they would only end up flattened on the ground */
    const pts = withCollar(grow(mad(p0, d0, -ry * 0.5), d0, L + ry * 0.5, 6, (s, d) => add(d, [0, (-0.06 - (0.16 + 0.24 * (1 - t)) * s * s) * dr, 0])));
    for (const p of pts) if (p[1] < 0.25) p[1] = 0.25;
    const rb = clamp(0.04 + L * 0.016, 0.04, ry * 0.5);
    W.tube(pts, limbRadii(pts, rb, rb * 0.3, true), 4, BARK.hemlock, () => 0.5, {kind: 0});
    const bf = along3(pts), step = 0.45 / D / Math.max(L, 0.5);
    const k0 = 0.92 + r() * 0.18;
    for (let s = Math.min(0.35, 0.45 / L); s <= 1.0001; s += step){
      const q = bf(s), ctr = trunkAt(q.p[1]);
      const rel = Math.hypot(q.p[0] - ctr[0], q.p[2] - ctr[2]) / (Lmax * env(clamp(q.p[1] / H, 0, 1)) + 0.5);
      const ao = lerp(0.68, 1.0, sstep(0.05, 0.95, rel)) * lerp(0.92, 1.05, t);
      const kk = k0 * (0.95 + r() * 0.1), tint = [kk, kk * (1 + (r() - 0.5) * 0.06), kk * 0.98];
      for (let k = 0; k < 2; k++){
        let up = rotate(q.d, UP, (k ? 1 : -1) * (0.3 + r() * 0.7));
        up = nrm(add(add(up, mul(sph(r), 0.45)), [0, (-0.15 - 0.6 * s) * dr, 0]));
        const face = nrm(add(sph(r), mul(UP, 0.5)));
        const sz = (2.3 + r() * 1.0) * (0.7 + 0.3 * Math.min(1, L / 3));
        F.card(mad(q.p, sph(r), 0.15), up, face, sz, sz, 0.08, S.fr(r() < 0.5 ? 2 : 3, r), tint, ao, vc, vr, 0.5, null);
      }
    }
    y += (0.32 + r() * 0.3) / Math.sqrt(D);
  }
  for (let i = 0; i < 7; i++){
    const p = trunkAt(H - 2.8 + i * 0.42);
    F.card(p, nrm(add(UP, mul(sph(r), 0.5))), sph(r), 1.3, 1.3, 0.4, S.fr(2 + (i & 1), r), [1.05, 1.05, 1], 1, vc, vr, 0.5, null);
  }
}

/* oak / maple: short trunk with root flare forking into sinuous scaffold limbs that branch (lateral + terminal
   children, collars sunk into the parent, each limb tapering to ~0.35 of its start) inside a broad crown ellipsoid.
   Leaf clumps sit on every terminal limb tip and fill a thick crown shell, tied to the nearest limb by a twig.
   Leaf species by seed: lobed oak or palmate maple. */
function genOak(S, H, r){
  const W = S.wood, F = S.leaf, D = S.density;
  const leafCell = r() < 0.55 ? 0 : 1;
  const R0 = H * (0.019 + r() * 0.004);
  const hb = H * (0.2 + r() * 0.14);
  const lean = [(r() - 0.5) * H * 0.1, (r() - 0.5) * H * 0.1];
  const cr = {c: [lean[0], lerp(hb, H, 0.47), lean[1]], r: [H * (0.3 + r() * 0.2), (H - hb) * (0.46 + r() * 0.08), 0]};
  cr.r[2] = cr.r[0] * (0.8 + r() * 0.35);
  const aoAt = p => { const e = ellDist(p, cr.c, cr.r); return lerp(0.55, 1.0, sstep(0.35, 1.0, e)) * lerp(0.82, 1.05, sstep(cr.c[1] - cr.r[1], cr.c[1] + cr.r[1], p[1])); };
  const trunk = grow([0, -0.4, 0], [lean[0] / H * 0.8 + (r() - 0.5) * 0.06, 1, lean[1] / H * 0.8 + (r() - 0.5) * 0.06], hb + 0.4 + 1.5, 6, (s, d) => add(d, mul(sph(r), 0.04)));
  /* the trunk stops just above the fork and hands over to the central leader (same radius, same direction), so no
     cut-off stump shows between the scaffold limbs */
  const tPts = [trunk[0], vlerp(trunk[0], trunk[1], 0.5)].concat(trunk.slice(1, 6));
  const fph = r() * TAU, tl = tPts.length, leadR = R0 * 0.6;
  W.tube(tPts, tPts.map((p, i) => i === tl - 1 ? leadR : R0 * (1 - 0.3 * Math.pow(Math.max(0, p[1]) / (hb + 1.5), 1.5)) + R0 * 0.55 * Math.exp(-Math.max(0, p[1]) / 0.8)), 12, BARK.oak, p => lerp(0.85, 0.6, sstep(0, hb + 2, p[1])),
    {kind: 0, cap: true, flare: (i, a) => 1 + 0.25 * Math.cos(5 * a + fph) * Math.exp(-Math.max(0, tPts[i][1]) / 1.1)});
  const fork = trunk[4];
  const nodes = [], tips = [];
  const MAXD = 3, KIDS = [[0.3, 0.5, 0.7, 1, 1], [0.5, 1, 1], [1, 1]];
  function limb(p0, d, L, rad, depth, prad){
    const nseg = depth < 2 ? 6 : 4, sink = (prad || rad) * 0.6;
    const pts = withCollar(grow(mad(p0, d, -sink), d, L + sink, nseg, (s, dd) => add(dd, add(mul(sph(r), 0.25), [0, 0.035, 0]))));
    const rEnd = Math.max(0.025, rad * 0.35), rads = limbRadii(pts, rad, rEnd, depth >= 2);   /* scaffold limbs: no collar ring at the fork */
    W.tube(pts, rads, depth < 1 ? 9 : depth < 3 ? 6 : 4, BARK.oak, aoAt, {kind: 0});
    for (let i = 2; i < pts.length; i++) if (depth >= 1 || i > nseg / 2) nodes.push({p: pts[i], r: rads[i]});
    const end = pts[pts.length - 1], endD = nrm(sub(end, pts[pts.length - 2]));
    if (depth >= MAXD){ tips.push({p: end, d: endD}); return; }
    const f = along3(pts);
    let kids = 0;
    for (const s0 of KIDS[depth]){
      const s = s0 >= 1 ? 1 : s0 + (r() - 0.5) * 0.12, q = s >= 1 ? {p: end, d: endD} : f(s);
      const out = nrm([q.p[0] - cr.c[0] + 1e-3, 0, q.p[2] - cr.c[2]]);
      let nd = rotate(q.d, nrm(cross(q.d, sph(r))), (s >= 1 ? 0.3 : 0.65) + r() * 0.4);
      nd = nrm(add(add(nd, mul(out, 0.4)), [0, 0.12, 0]));
      const room = roomTo(q.p, nd, cr.c, cr.r);
      if (room < 1.2) continue;
      const nl = Math.min(L * (s >= 1 ? 0.72 : 0.64) * (0.85 + r() * 0.3), room * (0.55 + 0.25 * r()));
      const pr = lerp(rad, rEnd, s);
      limb(q.p, nd, nl, pr * (s >= 1 ? 0.85 : 0.62), depth + 1, pr);
      kids++;
    }
    if (!kids) tips.push({p: end, d: endD});
  }
  const nS = 3 + ((r() * 1.6) | 0), az0 = r() * TAU;
  for (let k = 0; k < nS; k++){
    const az = az0 + k * TAU / nS + (r() - 0.5) * 0.7, el = 0.7 + r() * 0.45;
    const d = dirAE(az, el), L = (H - hb) * (0.3 + r() * 0.08);
    limb(fork, d, Math.min(L, roomTo(fork, d, cr.c, cr.r) * 0.5), R0 * 0.5, 0, R0 * 0.8);
  }
  limb(trunk[5], nrm(add(sub(trunk[5], trunk[4]), [(r() - 0.5) * 0.15, 0, (r() - 0.5) * 0.15])), (H - hb) * 0.38, leadR, 1, leadR * 0.5);

  const tintBase = leafCell === 0 ? [1, 1, 1] : [1.02, 1.03, 0.98];
  function clump(c, cd, R){
    const n = Math.max(4, Math.round(R * R * 1.6 * Math.sqrt(D)));
    const vc = vlerp(c, cr.c, 0.3), vr = [R * 1.7, R * 1.5, R * 1.7];
    const k0 = 0.9 + r() * 0.2, hue = (r() - 0.5) * 0.1, tint = [tintBase[0] * k0 * (1 + hue), tintBase[1] * k0, tintBase[2] * k0 * (1 - hue)];
    const out = nrm(sub(c, cr.c));
    for (let i = 0; i < n; i++){
      const q = inBall(r), p = [c[0] + q[0] * R, c[1] + q[1] * R * 0.75, c[2] + q[2] * R];
      const up = nrm(add(add(cd, mul(sph(r), 1.0)), [0, 0.35, 0]));
      const face = nrm(add(sph(r), mul(out, 0.6)));
      const sz = 1.9 + r() * 0.8;
      F.card(p, up, face, sz, sz, 0.25, S.fr(leafCell, r), tint, aoAt(p), vc, vr, 0.62, null);
    }
  }
  /* a clump on every bare limb tip */
  for (const tp of tips) clump(mad(tp.p, tp.d, 0.5), tp.d, 1.5 + r() * 0.8);
  /* and a thick crown shell (fewer clumps underneath, a few deliberate sky holes) */
  const holes = []; for (let k = 0; k < 3; k++){ const d = sph(r); holes.push({d: nrm([d[0], d[1] * 0.6, d[2]]), c: 0.95 + r() * 0.03}); }
  const ravg = (cr.r[0] + cr.r[1] + cr.r[2]) / 3, nC = Math.round(4 * Math.PI * ravg * ravg / 12 * Math.sqrt(D));
  let made = 0, tries = 0;
  while (made < nC && tries++ < nC * 6){
    const d = sph(r);
    if (d[1] < -0.35 && r() < 0.65) continue;
    let hole = false; for (const h of holes) if (dot(d, h.d) > h.c){ hole = true; break; }
    if (hole) continue;
    const e = 0.45 + 0.55 * Math.pow(r(), 0.5);
    const c = [cr.c[0] + d[0] * cr.r[0] * e, cr.c[1] + d[1] * cr.r[1] * e, cr.c[2] + d[2] * cr.r[2] * e];
    if (c[1] < hb + 1.5) continue;
    let best = null, bd = 1e9;
    for (const nd of nodes){ const q = sub(c, nd.p), dd = dot(q, q) - nd.r * 40; if (dd < bd){ bd = dd; best = nd; } }
    if (!best) break;
    let tw = sub(c, best.p), tl2 = vlen(tw);
    if (tl2 > 4){ tw = mul(tw, 4 / tl2); tl2 = 4; c[0] = best.p[0] + tw[0]; c[1] = best.p[1] + tw[1]; c[2] = best.p[2] + tw[2]; }
    if (tl2 > 0.6) W.tube([best.p, add(vlerp(best.p, c, 0.5), [0, tl2 * 0.08, 0]), c], [Math.min(0.07, best.r * 0.6), 0.035, 0.02], 3, BARK.oak, aoAt, {kind: 0});
    made++;
    clump(c, tl2 > 0.3 ? mul(tw, 1 / tl2) : d, 1.6 + r() * 1.0);
  }
}

/* rounded foundation shrub (azalea / boxwood) */
function genShrub(S, H, r){
  const W = S.wood, F = S.leaf, D = S.density;
  const rx = H * (0.48 + r() * 0.12), rz = rx * (0.85 + r() * 0.25), ry = H * 0.46, c = [0, H * 0.47, 0];
  const bumps = []; for (let k = 0; k < 6; k++) bumps.push({d: sph(r), a: 0.06 + r() * 0.1});
  const bump = d => { let m = 1; for (const b of bumps) m += b.a * Math.pow(Math.max(0, dot(d, b.d)), 3); return m; };
  for (let k = 0; k < 7; k++){
    const az = r() * TAU, pts = grow([(r() - 0.5) * 0.3, -0.1, (r() - 0.5) * 0.3], dirAE(az, 0.9 + r() * 0.4), H * 0.55, 3, (s, d) => add(d, mul(sph(r), 0.15)));
    W.tube(pts, [0.05, 0.04, 0.03, 0.02], 4, BARK.shrub, () => 0.35);
  }
  const area = 4 * Math.PI * Math.pow((Math.pow(rx * ry, 1.6) + Math.pow(rx * rz, 1.6) + Math.pow(ry * rz, 1.6)) / 3, 1 / 1.6);
  const n = Math.round(area * 13 * D);
  const vc = [0, H * 0.32, 0], vr = [rx, ry * 1.15, rz];
  for (let i = 0; i < n; i++){
    let d = sph(r); if (d[1] < -0.55) d = nrm([d[0], -d[1] * 0.4, d[2]]);
    const k = 1 - 0.28 * Math.pow(r(), 1.8), m = bump(d) * k;
    const p = [c[0] + d[0] * rx * m, Math.max(0.12 + r() * 0.15, c[1] + d[1] * ry * m), c[2] + d[2] * rz * m];
    const face = nrm(add(d, mul(sph(r), 0.5)));
    const up = nrm(add(cross(face, perp(face)), add(mul(sph(r), 0.8), [0, 0.6, 0])));
    const sz = (0.68 + r() * 0.2) * Math.min(1.2, Math.max(0.8, H / 4));
    const ao = lerp(0.38, 1.0, sstep(0.66, 1.0, k)) * lerp(0.6, 1.0, sstep(0.1, H * 0.55, p[1]));
    const kk = 0.9 + r() * 0.18;
    F.card(p, up, face, sz, sz, 0.3, S.fr(2, r), [kk, kk, kk * (0.95 + r() * 0.1)], ao, vc, vr, 0.8, null);
  }
}

/* lace-leaf Japanese maple: a dense, low, layered mound (about twice as wide as tall) with foliage down to the ground.
   A few arching limbs carry three concentric shells of spray cards laid like shingles down the mound surface;
   a handful of short pendant sprays hang at the rim. */
function genMaple(S, H, r){
  const W = S.wood, F = S.leaf, D = S.density;
  F.floor = 0.05;
  const Wd = H * (0.95 + r() * 0.25), Wz = Wd * (0.85 + r() * 0.25), top0 = [0, 0.9, 0];
  W.tube([[0, -0.2, 0], [0.05, 0.5, 0], top0], [0.2, 0.17, 0.14], 6, BARK.maple, () => 0.4, {kind: 0});
  /* mound profile: flat-ish top, full rounded sides reaching the ground at rho = 1 */
  const prof = rho => Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, rho), 2.4)), 1 / 1.7);
  const vc = [0, H * 0.1, 0], vr = [Wd * 1.05, H * 1.05, Wz * 1.05];
  const aoAt = p => lerp(0.5, 1.0, sstep(0.45, 1.0, ellDist(p, [0, 0, 0], [Wd, H, Wz]))) * lerp(0.62, 1.0, sstep(0, H * 0.55, p[1]));
  const bez = (a, b, c, d, t) => { const u = 1 - t; return [0, 1, 2].map(i => u * u * u * a[i] + 3 * u * u * t * b[i] + 3 * u * t * t * c[i] + t * t * t * d[i]); };
  const nB = 7 + ((r() * 3) | 0), az0 = r() * TAU;
  for (let k = 0; k < nB; k++){
    const az = az0 + k * TAU / nB + (r() - 0.5) * 0.5, dir = [Math.cos(az), 0, Math.sin(az)];
    const ex = Wd * Math.abs(dir[0]) + Wz * Math.abs(dir[2]);
    const pk = H * (0.55 + r() * 0.2), ed = ex * (0.55 + r() * 0.2), eh = H * (0.22 + r() * 0.2);
    const P = [top0, [dir[0] * ed * 0.1, pk, dir[2] * ed * 0.1], [dir[0] * ed * 0.6, pk * 1.05, dir[2] * ed * 0.6], [dir[0] * ed, eh, dir[2] * ed]];
    const pts = []; for (let i = 0; i <= 8; i++) pts.push(bez(P[0], P[1], P[2], P[3], i / 8));
    W.tube(pts, pts.map((_, i) => lerp(0.1, 0.02, i / 8)), 4, BARK.maple, aoAt, {kind: 0});
  }
  /* meridian arc-length CDF weighted by circumference, so cards are spread evenly over the mound surface */
  const NM = 64, cdf = [0];
  for (let i = 1; i <= NM; i++){
    const a = (i - 1) / NM, b = i / NM;
    const ds = Math.hypot((b - a) * (Wd + Wz) * 0.5, (prof(b) - prof(a)) * H);
    cdf.push(cdf[i - 1] + ds * (a + b) * 0.5 * (Wd + Wz) * 0.5);
  }
  const tot = cdf[NM];
  const lobes = []; for (let k = 0; k < 7; k++){ const d = sph(r); lobes.push({d: nrm([d[0], Math.abs(d[1]) * 0.7, d[2]]), a: 0.08 + r() * 0.14}); }
  const sample = u => { const L = u * tot; let i = 1; while (i < NM && cdf[i] < L) i++; return (i - 1 + (L - cdf[i - 1]) / ((cdf[i] - cdf[i - 1]) || 1)) / NM; };
  const area = TAU * tot;
  const nSk = Math.round(area * 1.6 * D), n = Math.round(area * 11 * D) + nSk;     /* nSk extra cards close the skirt */
  for (let i = 0; i < n; i++){
    const tau = i < nSk ? 0.8 + 0.2 * r() : sample(r()), phi = r() * TAU, cphi = Math.cos(phi), sphi = Math.sin(phi);
    const u = r(), k = u < 0.14 ? 0.62 : u < 0.38 ? 0.78 : u < 0.66 ? 0.9 : 1.0;
    const kj = k * (0.97 + r() * 0.06);
    const x = cphi * tau * Wd, z = sphi * tau * Wz, yv = prof(tau) * H;
    /* layered, lumpy outline: a few broad lobes push the surface out */
    const sd = nrm([cphi * tau, prof(tau) * 0.8, sphi * tau]);
    let lm = 0.95; for (const lb of lobes) lm += lb.a * Math.pow(Math.max(0, dot(sd, lb.d)), 4);
    const p = [x * kj * lm, 0.1 + (yv - 0.1) * kj * lm, z * kj * lm];
    if (p[1] < 0.15) p[1] = 0.15 + r() * 0.2;
    /* surface frame: T down the meridian (outward), N outward normal */
    const e = 0.01, t2 = Math.min(1, tau + e), t1 = Math.max(0, t2 - e);
    const T = nrm([cphi * (t2 - t1) * Wd, (prof(t2) - prof(t1)) * H, sphi * (t2 - t1) * Wz]);
    const A = [-sphi, 0, cphi], N = nrm(cross(A, T));
    /* sprays lie along the mound surface like shingles (card plane ~ tangent), pointing down-slope with a random
       twist; a few new shoots arch up/out on top and a few short pendants hang at the rim */
    const face = nrm(add(N, mul(sph(r), 0.6)));
    let up = rotate(T, N, (r() - 0.5) * 2.4), sz = 0.85 + r() * 0.35;
    const v = r();
    if (tau < 0.55 && v < 0.05) up = nrm(add(add(T, [0, 0.3, 0]), mul(sph(r), 0.3)));
    else if (tau > 0.86 && v < 0.08){ up = nrm(add(add([0, -1, 0], mul(T, 0.5)), mul(sph(r), 0.25))); sz *= 0.7; }
    else up = nrm(add(up, [0, -0.15, 0]));
    const hy = p[1] / H, kk = (0.86 + r() * 0.22) * lerp(0.92, 1.06, hy);
    const tint = [kk * (1 + 0.04 * hy), kk * (0.97 + 0.05 * hy), kk * 0.96];
    const ao = aoAt(p) * lerp(0.72, 1.0, (k - 0.62) / 0.38);
    F.card(p, up, face, sz, sz * 1.05, 0.12, S.fr(3, r), tint, ao, vc, vr, 0.68, null);
  }
}

/* rose of sharon (hibiscus syriacus): 4-6 trunks spread over ~0.6 ft fork at 1-2 ft into S-curved stems that open
   into a vase; leafy from ~1.2 ft on the outer stems, pink flowers scattered, a third of them with a cupped second card */
function genRose(S, H, r){
  const W = S.wood, F = S.leaf, D = S.density;
  const vc = [0, H * 0.6, 0], vr = [H * 0.3, H * 0.52, H * 0.3];
  const aoAt = p => lerp(0.45, 1.0, sstep(0.35, 1.0, ellDist(p, vc, vr))) * lerp(0.65, 1.0, sstep(0.5, H * 0.6, p[1]));
  const nT = 4 + ((r() * 3) | 0), az0 = r() * TAU, stems = [];
  for (let k = 0; k < nT; k++){
    const az = az0 + k * TAU / nT + (r() - 0.5) * 0.8, out = [Math.cos(az), 0, Math.sin(az)];
    const br = 0.15 + 0.45 * r(), b = [out[0] * br, -0.2, out[2] * br];
    const fh = 1 + r(), lean = 0.08 + r() * 0.12;
    const trunk = grow(b, dirAE(az, Math.PI / 2 - lean), fh / Math.cos(lean) + 0.2, 3, (s, d) => add(d, mul(sph(r), 0.05)));
    W.tube(trunk, [0.1, 0.095, 0.09, 0.085], 5, BARK.rose, aoAt, {kind: 0});
    const fp = trunk[3], nf = 2 + ((r() * 3) | 0);
    for (let j = 0; j < nf; j++){
      const saz = az + (j - (nf - 1) / 2) * 0.8 + (r() - 0.5) * 0.4, sout = [Math.cos(saz), 0, Math.sin(saz)];
      const sl = 0.12 + r() * 0.3, L = (H * (0.78 + r() * 0.22) - fp[1]) / Math.cos(sl);
      const ph = r() * TAU;
      const pts = grow(fp, dirAE(saz, Math.PI / 2 - sl), L, 6, (s, d) => add(d, add(mul(sout, 0.06 * Math.sin(s * TAU + ph)), mul(sph(r), 0.03))));
      W.tube(pts, limbRadii(pts, 0.065, 0.02, true), 4, BARK.rose, aoAt, {kind: 0});
      const outer = br > 0.35 || j === 0 || j === nf - 1;
      stems.push({pts, y0: outer ? 0.9 : 1.8});
      const nsh = 1 + ((r() * 3) | 0), f = along3(pts);
      for (let m = 0; m < nsh; m++){
        const q = f(0.4 + r() * 0.5), sd = nrm(add(rotate(q.d, nrm(cross(q.d, sph(r))), 0.5 + r() * 0.3), mul(sout, 0.3)));
        const shp = grow(q.p, sd, 0.6 + r() * 1.0, 3, null);
        W.tube(shp, [0.03, 0.025, 0.02, 0.012], 3, BARK.rose, aoAt, {kind: 0});
        stems.push({pts: shp, y0: 0});
      }
    }
  }
  const flowers = (S.meta[0] && S.meta[0].flowers) || [];
  for (const st of stems){
    const f = along3(st.pts), L = f.total + 0.3;
    for (let s = 0.05; s <= 1.0001; s += 0.21 / L / D){
      const q = f(s);
      if (q.p[1] < st.y0) continue;
      const nC = 2;
      for (let k = 0; k < nC; k++){
        const p = add(q.p, mul(inBall(r), 0.45));
        const up = nrm(add(q.d, mul(sph(r), 0.9)));
        const face = nrm(add(sph(r), mul(nrm([p[0], 0, p[2]]), 0.6)));
        const sz = 0.85 + r() * 0.3;
        const cell = r() < 0.18 ? 0 : 1;
        const kk = 0.9 + r() * 0.18, fr = S.fr(cell, r);
        const cb = F.card(p, up, face, sz, sz, 0.1, fr, [kk, kk, kk], aoAt(p), vc, vr, 0.5, null);
        if (cell === 0) for (const fl of flowers){
          if (r() > 0.25) continue;
          const fp = mad(featPos(cb, fr, fl.x, fl.y), cb.F, 0.02 * (dot(cb.F, nrm([p[0], 0.3, p[2]])) < 0 ? -1 : 1));
          const ax = nrm(add(cb.R, mul(cb.up, (r() - 0.5) * 1.2))), ang = (r() < 0.5 ? -1 : 1) * (0.52 + r() * 0.26);
          const ff = rotate(cb.F, ax, ang), fu = rotate(cb.up, ax, ang), fs = fl.R * sz * 2.3;
          F.card(fp, fu, ff, fs, fs, 0.5, S.fr(r() < 0.6 ? 4 : 6, r), [1, 1, 1], Math.min(1.05, aoAt(p) * 1.05), vc, vr, 0.3, null);
        }
      }
    }
  }
}

/* hydrangea: low mound of big leaves topped with pale blue/white mophead flowers */
function genHydrangea(S, H, r){
  const W = S.wood, F = S.leaf, D = S.density;
  const rx = H * (0.5 + r() * 0.1), rz = rx * (0.9 + r() * 0.2), ry = H * 0.45, c = [0, H * 0.43, 0];
  const vc = [0, H * 0.3, 0], vr = [rx, ry * 1.15, rz];
  for (let k = 0; k < 8; k++){
    const pts = grow([(r() - 0.5) * 0.3, -0.1, (r() - 0.5) * 0.3], dirAE(r() * TAU, 0.8 + r() * 0.5), H * 0.6, 3, (s, d) => add(d, mul(sph(r), 0.15)));
    W.tube(pts, [0.05, 0.04, 0.03, 0.02], 4, BARK.hydrangea, () => 0.35);
  }
  const area = 4 * Math.PI * Math.pow((Math.pow(rx * ry, 1.6) + Math.pow(rx * rz, 1.6) + Math.pow(ry * rz, 1.6)) / 3, 1 / 1.6);
  const n = Math.round(area * 4.2 * D);
  for (let i = 0; i < n; i++){
    let d = sph(r); if (d[1] < -0.5) d = nrm([d[0], -d[1] * 0.4, d[2]]);
    const k = 1 - 0.35 * Math.pow(r(), 1.5);
    const p = [c[0] + d[0] * rx * k, Math.max(0.15, c[1] + d[1] * ry * k), c[2] + d[2] * rz * k];
    const up = nrm(add(add(d, mul(sph(r), 0.8)), [0, 0.6, 0]));
    const face = nrm(add(d, mul(sph(r), 0.7)));
    const ao = lerp(0.4, 1.0, sstep(0.66, 1.0, k)) * lerp(0.6, 1.0, sstep(0.1, H * 0.55, p[1]));
    const kk = 0.9 + r() * 0.16;
    F.card(p, up, face, 0.8 + r() * 0.3, 0.85 + r() * 0.3, 0.25, S.fr(2, r), [kk, kk, kk], ao, vc, vr, 0.7, null);
  }
  const nH = Math.round(area * 0.55);
  for (let i = 0; i < nH; i++){
    let d = sph(r); if (d[1] < 0.05) d = nrm([d[0], Math.abs(d[1]) + 0.1, d[2]]);
    const k = 0.96 + r() * 0.08, hc = [c[0] + d[0] * rx * k, c[1] + d[1] * ry * k, c[2] + d[2] * rz * k];
    const s = 0.5 + r() * 0.2, hv = [hc[0] - d[0] * 0.12, hc[1] - d[1] * 0.12, hc[2] - d[2] * 0.12];
    const kk = 0.8 + r() * 0.14, tint = [kk, kk, kk], cell = r() < 0.6 ? 3 : 5;
    const up1 = nrm(add(UP, mul(sph(r), 0.25)));
    const f1 = rotate(nrm([d[0], 0, d[2]]), up1, r() * 0.6);
    for (let j = 0; j < 3; j++) F.card(hc, up1, rotate(f1, up1, j * Math.PI / 3), s, s, 0.5, S.fr(cell, r), tint, 1.0, hv, [0.4, 0.4, 0.4], 0.85, null);
    F.card(hc, f1, nrm(add(UP, mul(d, 0.3))), s, s, 0.5, S.fr(cell, r), tint, 1.0, hv, [0.4, 0.4, 0.4], 0.85, null);
  }
}

const GEN = {pine: genPine, hemlock: genHemlock, oak: genOak, shrub: genShrub, maple: genMaple, rose: genRose, hydrangea: genHydrangea};

/* ------------------------------------------------------------------ public */
REAL.veg = {
  create: function(THREE, renderer, opts){
    opts = opts || {};
    const core = REAL.core;
    const density = opts.density == null ? 1 : opts.density, dirAO = opts.dirAO == null ? 0.5 : opts.dirAO;
    const t0 = performance.now(), timing = {}; let tl = t0;
    const lap = k => { const n = performance.now(); timing[k] = Math.round(n - tl); tl = n; };

    const atl = {};
    atl.conifer = paintAtlas(core, [pinePainter(0), pinePainter(1), hemlockPainter(0), hemlockPainter(1)].map((p, k) => ({p, rect: GRID4[k]})), 11); lap("conifer");
    atl.broadleaf = paintAtlas(core, [broadleafPainter("oak"), broadleafPainter("maple"), shrubPainter(), lacePainter()].map((p, k) => ({p, rect: GRID4[k]})), 23); lap("broadleaf");
    atl.flower = paintAtlas(core, [
      {p: rosePainter(0), rect: [0, 0, 512]}, {p: rosePainter(1), rect: [512, 0, 512]}, {p: hydLeafPainter(), rect: [0, 512, 512]},
      {p: hydFlowerPainter([[140, 172, 236], [158, 170, 234], [206, 218, 242], [182, 178, 232], [168, 196, 244]], [170, 186, 214]), rect: [512, 512, 256]},
      {p: roseFlowerPainter(0), rect: [768, 512, 256]},
      {p: hydFlowerPainter([[196, 210, 238], [214, 222, 240], [176, 196, 236], [226, 228, 236], [190, 186, 228]], [200, 208, 226]), rect: [512, 768, 256]},
      {p: roseFlowerPainter(1), rect: [768, 768, 256]}], 37); lap("flower");
    const bark0 = paintBark(core, 0), bark1 = paintBark(core, 1); lap("bark");

    const tex = {};
    for (const k in atl){
      const a = atl[k];
      tex[k] = {map: core.texture(THREE, a.col, {srgb: true}), alpha: core.texture(THREE, a.alp), nor: core.texture(THREE, a.nor)};
      for (const t of [tex[k].map, tex[k].alpha, tex[k].nor]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    }
    const btex = [{map: core.texture(THREE, bark0.col, {srgb: true}), nor: core.texture(THREE, bark0.nm)}, {map: core.texture(THREE, bark1.col, {srgb: true}), nor: core.texture(THREE, bark1.nm)}];
    const leafCfg = {conifer: {rough: 0.7, trans: 0.28, ns: 0.9}, broadleaf: {rough: 0.6, trans: 0.4, ns: 1.0}, flower: {rough: 0.64, trans: 0.42, ns: 0.9}};
    /* one material set (shared by make() and plain batches); reveal batches get their own clones */
    function materialSet(reveal){
      const mats = {}, depth = {}, dist = {};
      for (const k in tex){
        const t = tex[k], cfg = leafCfg[k];
        const m = new THREE.MeshStandardMaterial({map: t.map, alphaMap: t.alpha, normalMap: t.nor, normalScale: new THREE.Vector2(cfg.ns, cfg.ns), roughness: cfg.rough, metalness: 0,
          side: THREE.DoubleSide, alphaTest: 0.05, vertexColors: true});
        m.alphaToCoverage = true;
        m.name = "veg-" + k;
        mats[k] = patchMaterial(THREE, m, {leaf: true, trans: cfg.trans, dirAO, key: k, reveal});
        depth[k] = patchDepth(new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking, alphaMap: t.alpha, alphaTest: 0.5, side: THREE.DoubleSide}), k, reveal, true);
        dist[k] = patchDepth(new THREE.MeshDistanceMaterial({alphaMap: t.alpha, alphaTest: 0.5, side: THREE.DoubleSide}), k + "x", reveal, true);
      }
      mats.bark = patchMaterial(THREE, new THREE.MeshStandardMaterial({map: btex[0].map, normalMap: btex[0].nor, normalScale: new THREE.Vector2(1.0, 1.0), roughness: 0.92, metalness: 0, vertexColors: true}),
        {leaf: false, trans: 0, dirAO: dirAO * 0.6, key: "bark", reveal, bark2: btex[1]});
      mats.bark.name = "veg-bark";
      if (reveal){
        depth.bark = patchDepth(new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking}), "bark", reveal, false);
        dist.bark = patchDepth(new THREE.MeshDistanceMaterial({}), "barkx", reveal, false);
      }
      return {mats, depth, dist};
    }
    const base = materialSet(null);
    lap("materials");
    const buildMs = performance.now() - t0;

    const frames = {}, metas = {};
    for (const k in atl){ frames[k] = atl[k].frames; metas[k] = atl[k].cells.map(c => c.meta); }
    function build(type, size, seed, dens){
      const gen = GEN[type];
      if (!gen) throw new Error("REAL.veg: unknown type '" + type + "'");
      const H = size || DEFAULT_SIZE[type];
      const r = core.rng(((seed == null ? 1 : seed) | 0) * 7919 + (hashStr(type) & 0xffff));
      const fr = frames[ATLAS_OF[type]];
      const S = {wood: new Builder(true), leaf: new Builder(false), density: dens == null ? density : dens,
        fr: (k, rr) => fr[k][rr() < 0.5 ? 1 : 0], meta: metas[ATLAS_OF[type]]};
      gen(S, H, r);
      /* scale so the top sits at the requested height */
      const top = Math.max(S.wood.maxY(), S.leaf.maxY());
      if (top > 0 && Math.abs(top / H - 1) > 0.01){ const s = H / top; S.wood.scale(s); S.leaf.scale(s); }
      return S;
    }
    function meshes(group, W, F, atlas, set){
      if (W.n){
        const m = new THREE.Mesh(W.geometry(THREE), set.mats.bark); m.name = "wood"; m.castShadow = m.receiveShadow = true;
        if (set.depth.bark){ m.customDepthMaterial = set.depth.bark; m.customDistanceMaterial = set.dist.bark; }
        group.add(m);
      }
      if (F.n){
        const m = new THREE.Mesh(F.geometry(THREE), set.mats[atlas]); m.name = "foliage";
        m.customDepthMaterial = set.depth[atlas]; m.customDistanceMaterial = set.dist[atlas];
        m.castShadow = m.receiveShadow = true; group.add(m);
      }
      return group;
    }
    function make(type, size, seed, o){
      const S = build(type, size, seed, o && o.density), g = new THREE.Group();
      g.name = "veg-" + type;
      meshes(g, S.wood, S.leaf, ATLAS_OF[type], base);
      g.userData.triangles = (S.wood.I.length + S.leaf.I.length) / 3;
      return g;
    }
    function batch(list, o){
      o = o || {};
      const reveal = o.reveal ? {u: {value: 1}, w: {value: o.window || 0.12}} : null;
      const set = reveal ? materialSet(reveal) : base;
      const wood = new Builder(true), leaf = {conifer: new Builder(false), broadleaf: new Builder(false), flower: new Builder(false)};
      const nl = list.length, win = reveal ? reveal.w.value : 0;
      list.forEach((it, i) => {
        const S = build(it.type, it.size, it.seed, it.density);
        const t = [it.x || 0, it.y || 0, it.z || 0], s = it.scale || 1, rot = it.rot || 0;
        const order = reveal ? (it.order != null ? it.order : (nl > 1 ? i / (nl - 1) : 0) * (1 - win)) : null;
        wood.append(S.wood, rot, s, t, order);
        leaf[ATLAS_OF[it.type]].append(S.leaf, rot, s, t, order);
      });
      const g = new THREE.Group(); g.name = "veg-batch";
      meshes(g, wood, new Builder(false), "conifer", set);
      for (const k in leaf) if (leaf[k].n) meshes(g, new Builder(true), leaf[k], k, set);
      if (reveal){ g.userData.reveal = reveal.u; g.userData.setReveal = v => { reveal.u.value = v; }; g.userData.materials = set; }
      return g;
    }
    function triangles(o){ let n = 0; o.traverse(m => { if (m.isMesh && m.geometry.index) n += m.geometry.index.count / 3; }); return n; }

    REAL.veg.buildMs = buildMs; REAL.veg.timing = timing;
    return {
      types: Object.keys(GEN),
      samples: [
        {type: "pine", size: 54, seed: 3, label: "white pine 54'", footprint: 30},
        {type: "hemlock", size: 33, seed: 2, label: "hemlock 33'", footprint: 21},
        {type: "oak", size: 46, seed: 3, label: "oak / maple 46'", footprint: 42},
        {type: "shrub", size: 4, seed: 1, label: "azalea 4'", footprint: 6},
        {type: "maple", size: 5, seed: 1, label: "lace-leaf maple 5'", footprint: 12},
        {type: "rose", size: 8.5, seed: 1, label: "rose of sharon 8.5'", footprint: 7.5},
        {type: "hydrangea", size: 3.5, seed: 1, label: "hydrangea 3.5'", footprint: 5.5}
      ],
      make, batch, triangles, materials: base.mats, buildMs, timing,
      atlases: atl, bark: [bark0, bark1]
    };
  }
};
})();
