/* REAL.finish: photoreal exterior finish materials for 106 Steinmann Ave (1953 Cape).
   REAL.finish.create(THREE, renderer, opts) -> { variants: { shingle, siding, trim, frame, glass, door, steel } }
   Every variant is { material, sample:[sx,sy,sz] (feet), optional rot, spread, count, tile, note }.

   Textures are procedural (canvas 2D + REAL.core noise), deterministic (fixed seeds), authored in physical inches.
   UVs: this module carries its own world-UV shader patch (same scheme as REAL.core.worldUV: feet per repeat, per-instance
   hash) because several finishes need things worldUV cannot do:
     - fragment-level UVs: every 40" shingle and every siding course picks its own offset / row / tone out of the
       texture, so a whole roof or a whole-wall siding panel never shows a repeat grid or a ladder of end laps.
       Those UVs jump at shingle and course joints, so the maps are sampled with explicit (continuous) gradients
       (textureGrad) and the jumps leave no mip seams.
     - shingle courses always run from the DOWNHILL edge (detected from the world-space V axis), whichever way a
       roof strip box is rotated.
     - glass is an interior-mapped room (a box behind the pane, ray-traced per pixel: real parallax as the camera moves)
       with per-window blinds / curtains / lamp state, plus a reflected treeline and cloud break-up.
     - low-frequency world-space tone variation, face-edge grime and drip streaks (trim, frame, steel).
   opts: { steel:"painted" (default galvanised), seedAttribute:true (read a per-instance float attribute "finSeed"
           instead of hashing the instance position, so pieces that are animated by translation keep their texture) } */
(function(){
"use strict";
const REAL = window.REAL = window.REAL || {};

/* ---------------------------------------------------------------- small helpers */
function sstep(a, b, x){ let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

/* scratch Float32 buffers reused across variants (textures are built one after another), released after create() */
let POOL = {};
function buf(name, n, zero){
  let b = POOL[name];
  if (!b || b.length < n) b = POOL[name] = new Float32Array(Math.max(n, 1024 * 512));
  else if (zero) b.fill(0, 0, n);
  return b.length === n ? b : b.subarray(0, n);
}

/* shared per-pixel white noise (-0.5..0.5), xorshift32, allocated once for the largest map (1024 x 512) x 2 */
const GRIT_N = 1024 * 512 * 2 + 4096;
let GRIT = null;
function grit(){
  if (GRIT) return GRIT;
  GRIT = new Float32Array(GRIT_N);
  let s = 0x2545F491 | 0;
  for (let i = 0; i < GRIT_N; i++){ s ^= s << 13; s ^= s >>> 17; s ^= s << 5; GRIT[i] = (s >>> 0) / 4294967296 - 0.5; }
  return GRIT;
}

/* low-res tileable fbm normalised to -0.5..0.5 */
function field(C, w, h, o){
  const f = C.normalize(C.fbm(w, h, o));
  for (let i = 0; i < f.length; i++) f[i] -= 0.5;
  return {f, w, h};
}
/* bilinear wrap upsample of a low-res periodic field to W x H */
function up(F, W, H, name){
  const out = name ? buf(name, W * H) : new Float32Array(W * H), w = F.w, h = F.h, f = F.f;
  if (w === W && h === H){ out.set(f); return out; }
  const xi0 = new Int32Array(W), xi1 = new Int32Array(W), xt = new Float32Array(W);
  for (let x = 0; x < W; x++){ let fx = (x + 0.5) / W * w - 0.5; if (fx < 0) fx += w; const a = fx | 0; xi0[x] = a; xi1[x] = a + 1 === w ? 0 : a + 1; xt[x] = fx - a; }
  const row = new Float32Array(w);
  for (let y = 0; y < H; y++){
    let fy = (y + 0.5) / H * h - 0.5; if (fy < 0) fy += h;
    const y0 = fy | 0, y1 = y0 + 1 === h ? 0 : y0 + 1, ty = fy - y0, r0 = y0 * w, r1 = y1 * w;
    for (let x = 0; x < w; x++) row[x] = f[r0 + x] + (f[r1 + x] - f[r0 + x]) * ty;
    const o = y * W;
    for (let x = 0; x < W; x++){ const a = row[xi0[x]]; out[o + x] = a + (row[xi1[x]] - a) * xt[x]; }
  }
  return out;
}

/* canvases */
function rgbCanvas(C, W, H, rgb){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  for (let i = 0, j = 0, k = 0; i < W * H; i++, j += 3, k += 4){ d[k] = rgb[j]; d[k+1] = rgb[j+1]; d[k+2] = rgb[j+2]; d[k+3] = 255; }   /* Uint8ClampedArray clamps + rounds */
  ctx.putImageData(img, 0, 0);
  return c;
}
/* data canvas: g = roughness, b = metalness (three reads roughnessMap.g and metalnessMap.b), r = optional mask, values 0..1 */
function dataCanvas(C, W, H, g, b, r){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  for (let i = 0, k = 0; i < W * H; i++, k += 4){
    const gv = g[i] * 255;
    d[k] = r ? r[i] * 255 : gv; d[k+1] = gv; d[k+2] = b ? b[i] * 255 : gv; d[k+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
/* tangent-space normal map (OpenGL, green = +V) from a tileable height field in INCHES; pu/pv = pixel size in inches */
function normalCanvas(C, W, H, hf, pu, pv, k){
  const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  const sx = (k || 1) / (2 * pu), sy = (k || 1) / (2 * pv);
  for (let y = 0; y < H; y++){
    const ru = ((y - 1 + H) % H) * W, rd = ((y + 1) % H) * W, row = y * W;
    for (let x = 0; x < W; x++){
      const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
      const nx = -(hf[row + xr] - hf[row + xl]) * sx, ny = -(hf[ru + x] - hf[rd + x]) * sy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), i = (row + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255; d[i+1] = (ny * inv * 0.5 + 0.5) * 255; d[i+2] = (inv * 0.5 + 0.5) * 255; d[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ---------------------------------------------------------------- shader patch */
const GLSL_FUNCS = `
float finHash(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float finH3(vec3 p){ p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float finVN(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(finH3(i), finH3(i + vec3(1.0, 0.0, 0.0)), f.x), mix(finH3(i + vec3(0.0, 1.0, 0.0)), finH3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(finH3(i + vec3(0.0, 0.0, 1.0)), finH3(i + vec3(1.0, 0.0, 1.0)), f.x), mix(finH3(i + vec3(0.0, 1.0, 1.0)), finH3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float finN1(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(fract(sin(mod(i, 289.0) * 127.1) * 43758.5453), fract(sin(mod(i + 1.0, 289.0) * 127.1) * 43758.5453), f); }
/* multiplier on reflected environment radiance (world reflection vector r): broken cloud above, a soft leafy treeline of
   pines / hardwoods at the horizon, grey-green lawn just below it and neutral ground for steep downward reflections */
vec3 finTrees(vec3 r, vec3 wp, float neutral){
  float az = atan(r.z, r.x) + dot(wp.xz, vec2(0.021, 0.013));
  float x = az * 9.0 + 40.0;
  float el = r.y;
  float leaf = finVN(vec3(x * 7.0, el * 70.0, 2.0)) * 0.6 + finVN(vec3(x * 23.0, el * 190.0, 5.0)) * 0.4;
  float h = 0.05 + 0.15 * finN1(x * 0.33) + 0.07 * finN1(x * 1.3 + 3.0) + 0.04 * finN1(x * 4.3 + 7.0) + 0.03 * pow(finN1(x * 13.0), 3.0);
  h += (leaf - 0.5) * 0.07;
  float t = 1.0 - smoothstep(h - 0.04, h + 0.04, el);
  float clump = finN1(x * 5.0 + el * 37.0) * 0.5 + leaf * 0.5;
  vec3 tree = vec3(0.05, 0.066, 0.045) * (0.45 + 1.2 * clump * clump);
  vec2 cp = r.xz / (max(el, 0.0) + 0.18) * 1.7;
  float cloud = finVN(vec3(cp, 1.3)) * 0.65 + finVN(vec3(cp * 2.7, 4.1)) * 0.35;
  vec3 k = mix(vec3(0.82 + 0.5 * smoothstep(0.35, 0.75, cloud)), tree, t);
  vec3 lawn = mix(vec3(0.6, 0.68, 0.54), vec3(0.62), neutral) * (0.8 + 0.4 * finN1(x * 3.0));
  vec3 gnd = mix(lawn, vec3(0.56, 0.54, 0.52), smoothstep(-0.2, -0.55, el));
  return mix(k, gnd, smoothstep(-0.03, -0.14, el));
}
#if __VERSION__ >= 300
  #define FIN_TEX(s) textureGrad(s, finUv, finDx, finDy)
#elif defined(GL_EXT_shader_texture_lod)
  #define FIN_TEX(s) texture2DGradEXT(s, finUv, finDx, finDy)
#else
  #define FIN_TEX(s) texture2D(s, finUv)
#endif
`;

/* fragment UV code per finish: sets finUv (+ finFlip for mirrored pieces) and finMul (albedo multiplier).
   vFinF.xy = position on the face in feet (y from the bottom / downhill edge), vFinF.zw = face size,
   finH = per-instance hash 0..1 (snapped from an integer-valued varying so chained hashes stay stable per pixel) */
const UV_SHINGLE = `
  { vec2 P = vFinF.xy;
    float cr = floor(P.y / 0.45);                                   /* 5.4in course index up the piece */
    float cid = cr + floor(finH * 4093.0) * 7.0;
    float sx = P.x / 3.33333 + finHash(cid * 1.371 + 0.27);         /* random stagger per course */
    float si = floor(sx);
    float hs = finHash(si * 0.6173 + cid * 1.7311 + 0.11);          /* one 40in shingle */
    float row = floor(finHash(hs * 31.7 + 2.3) * 4.0);
    finUv = vec2(sx - si + hs * 3.0, (P.y - cr * 0.45) / 1.8 + row * 0.25);   /* no mirroring: the raked tab edges all lean one way */
    finMul = vec3(0.97 + 0.06 * finHash(hs * 7.7 + 9.1));
    if (vFinF.w < 0.12){
      /* a strip's own butt / end face (box edge, ~0.84in): tab colour with a thin black asphalt edge at the bottom */
      finUv.y = row * 0.25 + 0.115;
      finMul *= 0.55 + 0.4 * smoothstep(0.0, 0.035, P.y);
    } else if (vFinT < 0.12 && cr < 0.5){
      /* bottom course of a thin strip: the real butt geometry already draws the shadow line, so soften the painted dash */
      finMul *= 1.0 + 1.5 * FIN_TEX(roughnessMap).r;
    }
  }`;
const UV_SIDING = `
  { vec2 P = vFinF.xy;
    float k = floor(P.y / 0.5);                                     /* 6in course index up the piece */
    float hk = finHash(k * 0.7131 + finH * 97.31 + 0.3);
    float row = floor(finHash(hk * 23.1 + 1.7) * 4.0);
    finUv = vec2(P.x / 6.0 + finHash(hk * 41.3 + 2.9) * 6.0, (P.y - k * 0.5) / 2.0 + row * 0.25);
    /* end laps: one every 12 ft (one vinyl panel length) at a random phase per course */
    float xs = mod(P.x + finHash(hk * 61.7 + 4.1) * 12.0, 12.0);
    float ds = min(xs, 12.0 - xs), fwx = max(fwidth(P.x), 1e-4);
    float lw = 0.012;
    float line = (1.0 - smoothstep(0.0, lw + fwx, ds)) * lw / (lw + fwx);
    float ov = (1.0 - smoothstep(0.09 - fwx, 0.09 + fwx, ds)) * step(xs, 6.0);
    finMul = vec3((1.0 - 0.45 * line) * (1.0 + 0.02 * ov));
  }`;

/* glass: interior-mapped room behind the pane + blinds / curtains / grilles, computed per pixel.
   Writes diffuseColor (the interior as seen through the glass, lit like a surface at the pane) and finEm (night glow). */
const GLASS_FRAG = `
  {
    vec2 P = vFinF.xy, S = vFinF.zw;
    vec3 R = vFinV;
    float kz = max(-R.z, 0.002 * length(R));
    vec2 fw = max(fwidth(P), vec2(1e-4));
    /* the room: one box per pane */
    float hR = finHash(finH * 211.3 + 0.37);
    float h1 = finHash(hR * 17.0 + 1.0), h2 = finHash(hR * 29.0 + 2.0), h3 = finHash(hR * 41.0 + 3.0), h4 = finHash(hR * 53.0 + 4.0), h5 = finHash(hR * 67.0 + 5.0);
    float mL = 1.0 + 4.0 * h1, mR = 1.0 + 4.0 * h2;
    float vF = -(2.2 + 0.8 * h3), vC = S.y + 0.6 + 0.9 * h4, Dp = 9.0 + 7.0 * h5;
    float tB = Dp / kz;
    float tX = R.x > 0.0 ? (S.x + mR - P.x) / max(R.x, 1e-5) : (-mL - P.x) / min(R.x, -1e-5);
    float tY = R.y > 0.0 ? (vC - P.y) / max(R.y, 1e-5) : (vF - P.y) / min(R.y, -1e-5);
    float t = min(tB, min(tX, tY));
    vec3 Hh = vec3(P + R.xy * t, kz * t);
    float dep = clamp(Hh.z / Dp, 0.0, 1.0);
    /* back-wall atlas (always sampled at the back-wall plane hit: continuous, so mip selection stays sane) */
    vec2 Pw = P + R.xy * tB;
    vec2 auv = vec2((Pw.x + mL) / 32.0 + floor(hR * 8.0) * 0.125 + 0.03, clamp((Pw.y - vF) / 8.0, 0.0, 1.0));
    vec3 aT = mapTexelToLinear(texture2D(map, auv)).rgb;
    vec3 eT = emissiveMapTexelToLinear(texture2D(emissiveMap, auv)).rgb;
    float tsel = finHash(hR * 83.0 + 6.0);
    vec3 tint = tsel < 0.25 ? vec3(1.0, 0.93, 0.82) : tsel < 0.45 ? vec3(0.93, 0.93, 0.9) : tsel < 0.6 ? vec3(0.84, 0.9, 0.96)
              : tsel < 0.75 ? vec3(0.88, 0.95, 0.84) : tsel < 0.9 ? vec3(1.0, 0.98, 0.95) : vec3(0.95, 0.85, 0.8);
    float lampOn = step(0.27, finHash(hR * 97.0 + 7.0));
    vec3 warm = vec3(1.0, 0.64, 0.34);
    float isB = step(tB, min(tX, tY));
    float isX = (1.0 - isB) * step(tX, tY);
    float isC = (1.0 - isB) * (1.0 - isX) * step(0.0, R.y);
    float isF = (1.0 - isB) * (1.0 - isX) * (1.0 - isC);
    float illum = 0.56 * mix(1.0, 0.28, pow(dep, 0.6));                    /* daylight falls off away from the window */
    /* soft corner darkening */
    float eX = min(Hh.x + mL, S.x + mR - Hh.x), eY = min(Hh.y - vF, vC - Hh.y), eZ = Dp - Hh.z;
    float ao = 0.6 + 0.4 * smoothstep(0.0, 1.4, isB * min(eX, eY) + isX * min(eY, eZ) + (isC + isF) * min(eX, eZ));
    vec3 room = isB * aT * tint
              + isX * tint * 0.6 * (0.9 + 0.1 * sin(Hh.y * 2.0))
              + isC * vec3(0.66, 0.65, 0.62) * 0.8
              + isF * vec3(0.24, 0.16, 0.1) * (0.75 + 0.3 * finHash(floor(Hh.x / 0.3) * 1.37 + hR * 50.0)) * (0.85 + 0.15 * finVN(vec3(Hh.x * 0.4, Hh.z * 3.0, 1.0)));
    room *= illum * ao;
    vec3 roomE = (isB * (eT * 1.6 + 0.05) + isX * 0.12 * (1.0 - 0.6 * dep) + isC * 0.16 * (1.0 - 0.7 * dep) + isF * 0.06) * ao;
    roomE *= mix(vec3(1.0), tint, 0.5) * (isB > 0.5 ? vec3(1.0) : warm) * lampOn + (1.0 - lampOn) * vec3(0.004, 0.005, 0.008);
    /* sub-windows: a pane wider than 6 ft is a picture window flanked by two 2.34 ft double-hungs */
    float wide = step(6.0, S.x);
    float seg = wide * (step(2.34, P.x) + step(S.x - 2.34, P.x));
    float a0 = wide * (seg < 0.5 ? 0.0 : seg < 1.5 ? 2.34 : S.x - 2.34);
    float a1 = wide > 0.5 ? (seg < 0.5 ? 2.34 : seg < 1.5 ? S.x - 2.34 : S.x) : S.x;
    float hs = finHash(hR * 7.31 + seg * 3.17 + 0.5);
    float s1 = finHash(hs * 11.0 + 0.1), s2 = finHash(hs * 23.0 + 0.2), s3 = finHash(hs * 37.0 + 0.3), s4 = finHash(hs * 51.0 + 0.4), s5 = finHash(hs * 71.0 + 0.5), s6 = finHash(hs * 89.0 + 0.6);
    /* curtains, 0.3 ft behind the glass: side drapes or a full sheer */
    vec2 Pc = P + R.xy * (0.3 / kz);
    float wc = 0.45 + 0.4 * s6;
    float drape = step(s5, 0.3), sheer = step(0.3, s5) * step(s5, 0.42);
    float inL = (1.0 - smoothstep(a0 + wc - fw.x, a0 + wc + fw.x, Pc.x)) * smoothstep(a0 - 0.7, a0 - 0.6, Pc.x);
    float inR = smoothstep(a1 - wc - fw.x, a1 - wc + fw.x, Pc.x) * (1.0 - smoothstep(a1 + 0.6, a1 + 0.7, Pc.x));
    float fq = Pc.x * 19.0 + 1.6 * sin(Pc.x * 4.3 + Pc.y * 0.4) + s6 * 40.0;
    float fold = 0.5 + 0.5 * sin(fq);
    fold = mix(fold, 0.5, smoothstep(0.15, 0.5, fw.x * 19.0 / 6.283));
    float csel = finHash(hs * 13.0 + 0.7);
    vec3 cc = csel < 0.35 ? vec3(0.78, 0.76, 0.7) : csel < 0.55 ? vec3(0.72, 0.66, 0.54) : csel < 0.7 ? vec3(0.4, 0.45, 0.36)
            : csel < 0.85 ? vec3(0.36, 0.41, 0.48) : vec3(0.42, 0.18, 0.16);
    vec3 col = room, em = roomE;
    float cov = drape * max(inL, inR) + sheer * 0.62 * smoothstep(a0 - 0.6, a0 - 0.5, Pc.x) * (1.0 - smoothstep(a1 + 0.5, a1 + 0.6, Pc.x));
    vec3 cLit = (sheer > 0.5 ? vec3(0.8, 0.79, 0.75) : cc) * (0.8 + 0.2 * fold) * 0.55;
    col = mix(col, cLit, cov);
    em = mix(em, (sheer > 0.5 ? vec3(0.8) : cc) * (0.75 + 0.25 * fold) * 0.45 * warm * (0.15 + 0.85 * lampOn), cov);
    /* blinds, 0.1 ft behind the glass, hanging from the head of each sub-window */
    float hasB = step(0.2, s1);
    float drop = s2 < 0.42 ? 1.0 : (s2 < 0.78 ? 0.3 + 0.55 * fract(s2 * 7.3) : 0.1 + 0.07 * fract(s2 * 13.1));
    float open = step(0.5, s3);
    float pitch = s4 < 0.6 ? 0.145 : 0.085;
    vec2 Pb = P + R.xy * (0.1 / kz);
    float yb = S.y * (1.0 - drop);
    float inBx = smoothstep(a0 + 0.01 - fw.x, a0 + 0.01 + fw.x, Pb.x) * (1.0 - smoothstep(a1 - 0.01 - fw.x, a1 - 0.01 + fw.x, Pb.x));
    float inB = hasB * inBx * smoothstep(yb - fw.y, yb + fw.y, Pb.y);
    float sc = (S.y + 0.3 - Pb.y) / pitch, sf = fract(sc);
    float fs = fw.y / pitch;                                              /* pixel footprint in slats: filters the slat pattern */
    float aa = smoothstep(0.12, 0.45, fs);
    float su = fract(sc + 0.5) - 0.54;                                    /* 0 just below each slat edge */
    float cw = 0.07;
    float crease = (1.0 - smoothstep(0.0, cw + fs, abs(su))) * cw / (cw + fs);
    float closedV = (0.92 + 0.06 * cos((sf - 0.35) * 6.2832)) * (1.0 - 0.45 * crease);
    closedV = mix(closedV, 0.89, aa);
    float slat = 1.0 - smoothstep(0.5 - fs, 0.6 + fs, sf);
    slat = mix(slat, 0.55, aa);
    float bsel = finHash(hs * 31.0 + 0.9);
    vec3 bc = bsel < 0.7 ? vec3(0.52, 0.51, 0.49) : bsel < 0.88 ? vec3(0.5, 0.47, 0.4) : vec3(0.44, 0.44, 0.43);
    float rail = 1.0 - smoothstep(yb + 0.09 - fw.y, yb + 0.09 + fw.y, Pb.y);
    float lx = min(abs(Pb.x - mix(a0, a1, 0.16)), abs(Pb.x - mix(a0, a1, 0.84)));
    float lad = (1.0 - smoothstep(0.0, 0.008 + fw.x, lx)) * 0.008 / (0.008 + fw.x);
    vec3 bOpen = mix(col * 0.75 + bc * 0.06, bc * (0.86 + 0.14 * cos((sf - 0.25) * 4.0)), slat);
    vec3 bCol = mix(bOpen, bc * closedV, 1.0 - open);
    bCol = mix(bCol, bc * 0.82, rail) * (1.0 - 0.18 * lad);
    vec3 bEm = mix(mix(em * 0.8, vec3(0.42) * (0.55 + 0.45 * lampOn) * warm * lampOn, slat), vec3(0.5) * closedV * warm * lampOn, 1.0 - open);
    col = mix(col, bCol, inB);
    col *= 0.52;                                                          /* glass transmission + window recess: things behind the pane see less light than the facade */
    em = mix(em, bEm, inB);
    /* grilles between the glass in the flanking double-hungs of a picture window (as on the front of the house) */
    float gx = abs(P.x - 0.5 * (a0 + a1)), gy = min(abs(P.y - S.y * 0.25), abs(P.y - S.y * 0.75)), gw = 0.028;
    float grl = wide * step(0.5, abs(seg - 1.0)) * max(1.0 - smoothstep(gw - fw.x, gw + fw.x, gx), 1.0 - smoothstep(gw - fw.y, gw + fw.y, gy));
    col = mix(col, vec3(0.66, 0.65, 0.62), grl);
    em = mix(em, em * 0.25, grl);
    diffuseColor.rgb *= col;
    finEm = em;
  }`;

/* o: { tile:[uFt,vFt], grain:bool, jit:[ju,jv], vSteps:n, downhill:bool, frag:<uv code>, glass:bool,
        macro:[amp, cyclesPerFoot], drip:amp, edge:[widthFt, amount], refl:{k, mask:bool, neutral:0..1} } */
function finPatch(THREE, m, o, seedAttr){
  const f5 = n => (+n).toFixed(5);
  const tile = o.tile || [1, 1], jit = o.jit || [0, 0];
  const key = "fin3:" + JSON.stringify(o) + (seedAttr ? ":seed" : "");
  const vq = o.vSteps ? `fJ.y = floor(fJ.y * ${f5(o.vSteps)}) / ${f5(o.vSteps)};` : "";
  const hashCode = `fract(sin(dot(floor(fI * 2.31 + 0.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453)`;
  const uvCode = `
    #ifdef USE_UV
      vec2 rUv = uv;
      vFinH = 0.0;
      vFinF = vec4(uv, 1.0, 1.0);
      ${o.downhill ? "vFinT = 1.0;" : ""}
      #ifdef USE_INSTANCING
      {
        vec3 fS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vec3 fN = abs(normal);
        vec2 fD = fN.x > 0.5 ? vec2(fS.z, fS.y) : (fN.y > 0.5 ? vec2(fS.x, fS.z) : vec2(fS.x, fS.y));
        vec2 fP = uv * fD;
        ${o.grain ? "if (fD.x > fD.y){ fP = vec2(uv.y * fD.y, uv.x * fD.x); fD = fD.yx; }" : ""}
        ${o.downhill ? `{ vec3 fBl = fN.y > 0.5 ? vec3(0.0, 0.0, normal.y > 0.0 ? -1.0 : 1.0) : vec3(0.0, 1.0, 0.0);
            vec3 fBw = mat3(modelMatrix) * (mat3(instanceMatrix) * fBl);
            if (fBw.y < -1e-4 * length(fBw)) fP.y = fD.y - fP.y; }` : ""}
        vec3 fI = instanceMatrix[3].xyz;
        float fH = ${seedAttr ? `finSeed != 0.0 ? fract(finSeed * 0.7548777 + 0.1234) : ${hashCode}` : hashCode};
        vFinH = floor(fH * 8192.0) + 0.5;          /* integer-valued: survives interpolation exactly */
        ${o.downhill ? "vFinT = fN.y > 0.5 ? fS.y : (fN.x > 0.5 ? fS.x : fS.z);" : ""}
        vFinF = vec4(fP, fD);
        vec2 fJ = vec2(fH, fract(fH * 7.13));
        ${vq}
        rUv = fP / vec2(${f5(tile[0])}, ${f5(tile[1])}) + fJ * vec2(${f5(jit[0])}, ${f5(jit[1])});
      }
      #endif
      vUv = ( uvTransform * vec3( rUv, 1 ) ).xy;
    #endif`;
  const glassV = o.glass ? `
    {
      #ifdef USE_INSTANCING
        mat3 fM = mat3(modelMatrix) * mat3(instanceMatrix);
      #else
        mat3 fM = mat3(modelMatrix);
      #endif
      vec3 fNl = normal;
      vec3 fBl = abs(fNl.y) > 0.5 ? vec3(0.0, 0.0, fNl.y > 0.0 ? -1.0 : 1.0) : vec3(0.0, 1.0, 0.0);
      vec3 fTl = abs(fNl.y) > 0.5 ? vec3(1.0, 0.0, 0.0) : cross(fBl, fNl);
      vec3 fV = vFinW - cameraPosition;
      vFinV = vec3(dot(fV, normalize(fM * fTl)), dot(fV, normalize(fM * fBl)), dot(fV, normalize(fM * fNl)));
    }` : "";

  let alb = "";
  if (o.macro) alb += `
    { float mn = finVN(vFinW * ${f5(o.macro[1])}) * 0.65 + finVN(vFinW * ${f5(o.macro[1] * 3.7)} + 5.3) * 0.35;
      diffuseColor.rgb *= 1.0 + ${f5(o.macro[0])} * (mn - 0.5) * 2.0; }`;
  if (o.drip) alb += `
    { float dn = finVN(vec3(vFinW.x * 2.7, vFinW.y * 0.22, vFinW.z * 2.7)) * 0.7 + finVN(vec3(vFinW.x * 9.0, vFinW.y * 0.7, vFinW.z * 9.0) + 3.1) * 0.3;
      diffuseColor.rgb *= 1.0 - ${f5(o.drip)} * smoothstep(0.45, 0.85, dn) * vec3(0.94, 1.0, 1.12); }`;
  if (o.edge) alb += `
    { vec2 fe = min(vFinF.xy, vFinF.zw - vFinF.xy); float ed = max(min(fe.x, fe.y), 0.0);
      float g = 1.0 - smoothstep(0.0, ${f5(o.edge[0])}, ed);
      float gn = finVN(vec3(vFinF.xy * 9.0, 0.0) + vFinW * 1.7);
      diffuseColor.rgb *= 1.0 - ${f5(o.edge[1])} * g * g * (0.35 + 1.3 * gn) * vec3(0.92, 0.97, 1.08); }`;
  let refl = "";
  if (o.refl) refl = `
    #if defined( USE_ENVMAP )
    { vec3 fr = inverseTransformDirection(reflect(-geometry.viewDir, geometry.normal), viewMatrix);
      vec3 fk = finTrees(fr, vFinW, ${f5(o.refl.neutral || 0)}) * ${f5(o.refl.k)};
      ${o.refl.mask ? "float fm = 1.0 - smoothstep(0.10, 0.22, roughnessFactor); fk = mix(vec3(1.0), fk, fm);" : ""}
      radiance *= fk; }
    #endif`;

  const SC = THREE.ShaderChunk;
  const sub = (s, a, b) => { if (s.indexOf(a) < 0) console.warn("REAL.finish: shader patch target missing: " + a.slice(0, 40)); return s.split(a).join(b); };
  const mapChunk = o.glass ? GLASS_FRAG
    : sub(SC.map_fragment, "texture2D( map, vUv )", "FIN_TEX( map )") + "\n diffuseColor.rgb *= finMul;";
  const roughChunk = sub(SC.roughnessmap_fragment, "texture2D( roughnessMap, vUv )", "FIN_TEX( roughnessMap )");
  const metalChunk = sub(SC.metalnessmap_fragment, "texture2D( metalnessMap, vUv )", "FIN_TEX( metalnessMap )");
  const normChunk = o.glass ? SC.normal_fragment_maps
    : sub(SC.normal_fragment_maps, "vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;", "vec3 mapN = FIN_TEX( normalMap ).xyz * 2.0 - 1.0; mapN.x *= finFlip;");
  const emChunk = o.glass ? "totalEmissiveRadiance *= finEm;" : SC.emissivemap_fragment;
  const prelude = `
    float finH = floor(vFinH) / 8192.0;
    vec2 finUv = vUv; vec2 finDx = dFdx(vUv); vec2 finDy = dFdy(vUv);
    float finFlip = 1.0; vec3 finMul = vec3(1.0); vec3 finEm = vec3(1.0);
    ${o.frag || ""}`;

  m.onBeforeCompile = function(sh){
    const vHead = "varying vec4 vFinF;\nvarying vec3 vFinW;\nvarying float vFinH;\n" + (o.glass ? "varying vec3 vFinV;\n" : "") + (o.downhill ? "varying float vFinT;\n" : "") + (seedAttr ? "attribute float finSeed;\n" : "");
    sh.vertexShader = vHead + sub(sub(sh.vertexShader, "#include <uv_vertex>", uvCode), "#include <worldpos_vertex>", `#include <worldpos_vertex>
        { vec4 fW = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            fW = instanceMatrix * fW;
          #endif
          vFinW = (modelMatrix * fW).xyz; }
        ${glassV}`);
    let fs = sh.fragmentShader;
    fs = sub(fs, "#include <common>", "#include <common>\n" + GLSL_FUNCS);
    fs = sub(fs, "void main() {", "void main() {\n" + prelude);
    fs = sub(fs, "#include <map_fragment>", mapChunk + "\n" + alb);
    fs = sub(fs, "#include <roughnessmap_fragment>", roughChunk);
    fs = sub(fs, "#include <metalnessmap_fragment>", metalChunk);
    fs = sub(fs, "#include <normal_fragment_maps>", normChunk);
    fs = sub(fs, "#include <emissivemap_fragment>", emChunk);
    fs = sub(fs, "#include <lights_fragment_maps>", "#include <lights_fragment_maps>\n" + refl);
    sh.fragmentShader = "varying vec4 vFinF;\nvarying vec3 vFinW;\nvarying float vFinH;\n" + (o.glass ? "varying vec3 vFinV;\n" : "") + (o.downhill ? "varying float vFinT;\n" : "") + fs;
  };
  m.customProgramCacheKey = function(){ return key; };
  m.needsUpdate = true;
  return m;
}

/* ================================================================ SHINGLE
   Laminated architectural shingle, medium-grey blend. Tile = one 40" shingle x 21.6" = four different 5.4" courses.
   The shader cuts the roof into 40" shingles (random stagger per course) and gives each one its own course row,
   horizontal offset and tone, so the texture never repeats as a grid. Canvas bottom (v=0) = downhill butt edge.
   Per course: top-layer tabs in four tone classes with raked (dragon-tooth) cut edges that mostly lean one way; short,
   near-black raked dashes along the butt where the double-ply tabs' thick edges face down-slope; a few narrow wedge
   slots along the raked edges showing the dark backer. */
function shingleMaps(C){
  const W = 1024, H = 512, N = W * H, NC = 4, CH = H / NC;
  const pu = 40 / W, pv = 21.6 / H, E = 5.4;
  const rnd = C.rng(7103), G = grit();
  const blot = up(field(C, 128, 64, {octaves: 4, base: 5, sx: 2, sy: 1, seed: 11, persistence: 0.55}), W, H, "fa");
  const mott = up(field(C, 256, 128, {octaves: 2, base: 24, sx: 2, sy: 1, seed: 12}), W, H, "fb");
  /* granule clusters (~0.1-0.2in): survive mip-mapping, read as the sandy surface of real shingles */
  const clus = up({f: G.subarray(N, N + 256 * 128), w: 256, h: 128}, W, H, "fc");
  const tone = buf("t1", N), tint = buf("t2", N), shade = buf("t3", N), hgt = buf("hgt", N), rough = buf("rough", N), mask = buf("mask", N, true);
  const BASE = [121, 124, 128];
  const CLASS = [-6, -2, 1, 5];
  const MAXT = 80;
  const tT = new Float32Array(MAXT), tTi = new Float32Array(MAXT), tB = new Float32Array(MAXT), tBH = new Float32Array(MAXT), tBD = new Float32Array(MAXT);
  const tBF = new Float32Array(MAXT), tBA = new Uint8Array(MAXT);
  const bX = new Float32Array(MAXT + 1), bS = new Float32Array(MAXT + 1), cx = new Float32Array(MAXT + 1);
  const sW = new Float32Array(MAXT), sH = new Float32Array(MAXT);
  for (let k = 0; k < NC; k++){
    /* periodic sequence of tab boundaries across the 40" tile; the dragon-tooth cut edges are raked, nearly all the
       same way (this is what draws the faint diagonal lattice seen on real architectural roofs) */
    const x0 = rnd() * W;
    let nT = 0, x = x0;
    for (;;){
      bX[nT] = x; bS[nT] = (rnd() < 0.88 ? 1 : -0.4) * (0.32 + rnd() * 0.38) * pv / pu;   /* px of shift per px row */
      nT++;
      const w = (3.2 + Math.pow(rnd(), 1.1) * 4.6) / pu;
      if (x + w > x0 + W - 3.2 / pu || nT >= MAXT) break;
      x += w;
    }
    bX[nT] = x0 + W; bS[nT] = bS[0];
    for (let i = 0; i < nT; i++){
      const r = rnd();
      tT[i] = CLASS[r < 0.2 ? 0 : r < 0.5 ? 1 : r < 0.8 ? 2 : 3] + (rnd() - 0.5) * 5;
      tTi[i] = (rnd() - 0.5) * 2.5;                                   /* warm / cool granule blend */
      tB[i] = rnd() < 0.8 ? 1 : 0;                                    /* double-ply tab: dark butt dash */
      tBH[i] = 0.65 + rnd() * 0.6;                                     /* dash height, in */
      tBD[i] = 0.19 + rnd() * 0.08;                                   /* dash darkness */
      tBF[i] = 0.35 + rnd() * 0.65;                                   /* share of the tab's width the dash covers */
      tBA[i] = rnd() < 0.5 ? 0 : 1;                                   /* dash anchored at the tab's left or right edge */
      const slot = rnd() < 0.2;                                       /* narrow wedge slot along the raked edge (backer shows) */
      sW[i] = slot ? (0.35 + rnd() * 0.45) / pu : 0;
      sH[i] = 1.5 + rnd() * 1.6;
    }
    for (let t = 0; t < CH; t++){
      const y = H - 1 - (k * CH + t), row = y * W;
      const yin = (t + 0.5) * pv;
      const head = 1 - 0.34 * Math.pow(sstep(E - 1.3, E, yin), 1.6);    /* contact shade under the next course's butt */
      const edge = yin < 0.1 ? 0.72 : 1;                              /* the butt's own edge */
      const slope = 0.03 * (1 - yin / E);
      const thin = 0.55 + 0.45 * sstep(0.12, 0.5, yin);               /* single-ply butt: a thinner, lighter line */
      for (let i = 0; i <= nT; i++) cx[i] = bX[i] + bS[i] * t;
      cx[nT] = cx[0] + W;
      for (let i = 1; i <= nT; i++) if (cx[i] < cx[i - 1] + 2) cx[i] = cx[i - 1] + 2;   /* raked edges never cross */
      for (let i = 0; i < nT; i++){
        const xa = cx[i], xb = cx[i + 1];
        const dash = tB[i] ? tBD[i] + (1 - tBD[i]) * Math.pow(sstep(tBH[i] - 0.7, tBH[i] + 0.06, yin), 0.8) : 1;
        const xe = tBA[i] ? xb - tBF[i] * (xb - xa) : xa + tBF[i] * (xb - xa);
        const tv = tT[i], ti = tTi[i], hd = head * edge;
        const p0 = Math.ceil(xa), p1 = Math.ceil(xb);
        for (let px = p0; px < p1; px++){
          const xx = px >= W ? px - W : px < 0 ? px + W : px, p = row + xx;
          const dl = px - xa, dr = xb - px;
          const inD = tB[i] && (tBA[i] ? px >= xe : px < xe);
          const band = inD ? dash : thin;
          tone[p] = tv; tint[p] = ti;
          shade[p] = hd * band * (dl < 1.6 ? 0.8 : dr < 1.2 ? 1.05 : 1);   /* cut edge: thin shadow on one side, catch-light on the other */
          hgt[p] = (dl < 1.0 ? 0.07 : 0.1) + slope - (inD ? 0.04 * (1 - sstep(0, 0.12, yin)) : 0);
          rough[p] = band < 0.8 ? 0.92 : 0.88;
          mask[p] = inD ? (1 - dash) / (1 - tBD[i]) : 0;              /* butt-dash mask (red channel of the roughness map) */
        }
        /* wedge slot following this tab's raked left edge, exposing the darker backer */
        if (sW[i] > 0 && yin < sH[i]){
          const half = sW[i] * 0.5 * (1 - 0.6 * yin / sH[i]), q0 = Math.floor(xa - half), q1 = Math.ceil(xa + half);
          for (let px = q0; px < q1; px++){
            const xx = ((px % W) + W) % W, p = row + xx;
            const dE = Math.min(px + 0.5 - (xa - half), xa + half - px - 0.5) * pu;
            const occ = 0.8 + 0.2 * sstep(0, 0.15, Math.min(dE, sH[i] - yin));
            tone[p] = -4; tint[p] = 0; shade[p] = (0.42 + 0.1 * sstep(0, 1.2, yin)) * occ * head * edge;
            hgt[p] = slope; rough[p] = 0.93; mask[p] = 0;
          }
        }
      }
    }
  }
  /* granules: per-pixel speckle with light and black granules, blend patches */
  const rgb = buf("rgb", N * 3);
  for (let i = 0; i < N; i++){
    const g0 = G[i], g1 = G[i + 3571], g2 = G[i + 91711];
    let v = tone[i] + blot[i] * 3 + mott[i] * 4 + g0 * 17 + clus[i] * 16;
    if (g1 > 0.465) v += 22 + g2 * 14;
    else if (g1 < -0.45) v -= 20 + g2 * 8;
    const s = shade[i];
    let ti = tint[i];
    const g3 = G[i + 211111];
    if (g3 > 0.482) ti += 9;                                          /* a few tan granules in the grey blend */
    else if (g3 < -0.485) v -= 26;                                     /* and some jet-black ones */
    rgb[i * 3] = (BASE[0] + v + ti + g2 * 4) * s; rgb[i * 3 + 1] = (BASE[1] + v + ti * 0.3) * s; rgb[i * 3 + 2] = (BASE[2] + v - ti * 0.7 - g2 * 3) * s;
    hgt[i] += g0 * 0.012 + g1 * 0.006 + clus[i] * 0.012 + blot[i] * 0.02;
    rough[i] += mott[i] * 0.06 + g2 * 0.04;
  }
  return {W, H, rgb, hgt, rough, mask, pu, pv};
}

/* ================================================================ SIDING
   Vinyl clapboard, 6" exposure, 6 ft x 2 ft tile = four different boards. The shader picks a board row and a random
   horizontal offset per 6" course (whole-wall panels never show a ladder of laps) and draws an end lap every 12 ft at a
   random phase per course. Canvas bottom (v=0) = underside of a board's butt.
   Embossed cedar grain (fine streaks + a coarser irregular octave + occasional long streaks), rounded nose, sloped face,
   soft occlusion under the next board's butt. */
function sidingMaps(C){
  const W = 1024, H = 512, N = W * H, NB = 4, BH = H / NB;
  const pu = 72 / W, pv = 24 / H;
  const rnd = C.rng(4242), G = grit();
  const streak = up(field(C, 64, 512, {octaves: 3, base: 7, sx: 1, sy: 18, seed: 31, persistence: 0.65}), W, H, "fa");
  const lines = up(field(C, 128, 512, {octaves: 2, base: 5, sx: 1, sy: 56, seed: 32, persistence: 0.6}), W, H, "fb");
  const coarse = up(field(C, 64, 256, {octaves: 3, base: 3, sx: 1, sy: 22, seed: 34, persistence: 0.6}), W, H, "fd");
  const mott = up(field(C, 64, 32, {octaves: 3, base: 3, sx: 2, sy: 1, seed: 33}), W, H, "fc");
  const rgb = buf("rgb", N * 3), hgt = buf("hgt", N), rough = buf("rough", N);
  const BASE = [137, 124, 121];
  for (let k = 0; k < NB; k++){
    const bt = (rnd() - 0.5) * 3;
    for (let t = 0; t < BH; t++){
      const y = H - 1 - (k * BH + t), row = y * W;
      const tin = (t + 0.5) * pv;
      let h;
      if (tin < 0.45){ const q = 1 - tin / 0.45; h = 0.58 - 0.34 * q * q; }
      else h = 0.1 + 0.48 * (6 - tin) / (6 - 0.45);
      const occ = (1 - 0.36 * Math.pow(sstep(3.4, 6.0, tin), 1.6))
                * (0.74 + 0.26 * sstep(0.0, 0.32, tin))
                * (1 + 0.05 * sstep(0.3, 0.5, tin) * (1 - sstep(0.55, 1.2, tin)));
      for (let x = 0; x < W; x++){
        const p = row + x;
        const s = streak[p], l = lines[p], c = coarse[p];
        const dl = sstep(-0.16, -0.34, l) + 0.7 * sstep(-0.3, -0.42, c);       /* sparse dark grain lines + a few long coarse streaks */
        hgt[p] = h + s * 0.01 + c * 0.012 - dl * 0.01 + G[p] * 0.002;
        const v = bt + s * 6 + c * 9 - dl * 11 + mott[p] * 5 + G[p] * 4;
        rgb[p * 3] = (BASE[0] + v) * occ; rgb[p * 3 + 1] = (BASE[1] + v * 0.96) * occ; rgb[p * 3 + 2] = (BASE[2] + v * 0.93) * occ;
        rough[p] = 0.5 + s * 0.05 + c * 0.05 + dl * 0.06 - mott[p] * 0.04 + (1 - occ) * 0.12;
      }
    }
  }
  return {W, H, rgb, hgt, rough, pu, pv};
}

/* ================================================================ TRIM / FRAME (white aluminium coil + vinyl extrusions)
   grain runs along canvas V (the piece's length; long tile so a 26 ft fascia does not repeat its dirt):
   faint extrusion lines, gentle oil-canning, orange peel, a soft multi-octave dirt film */
function whiteMaps(C, o){
  const W = o.W, H = o.H, N = W * H, pu = o.inU / W, pv = o.inV / H, ar = o.inV / o.inU;
  const G = grit();
  const wave = up(field(C, 16, 64, {octaves: 2, base: 2, sx: 1, sy: ar, seed: o.seed}), W, H, "fa");
  const dirt = up(field(C, 32, 256, {octaves: 6, base: 2, sx: 1, sy: ar, seed: o.seed + 1, persistence: 0.55}), W, H, "fb");
  const lines = up(field(C, 128, 8, {octaves: 2, base: 24, sx: 2, sy: 0.125, seed: o.seed + 2}), W, H, "fc");
  const B = o.base;
  const rgb = buf("rgb", N * 3), hgt = buf("hgt", N), rough = buf("rough", N);
  for (let i = 0; i < N; i++){
    const d = Math.max(0, dirt[i] + 0.08), g = G[i], g2 = G[i + 7919];
    const v = -d * d * o.dirt * 60 + lines[i] * o.lines * 6 + g * 2.2 + g2 * 1.2;
    rgb[i * 3] = B[0] + v; rgb[i * 3 + 1] = B[1] + v * 1.03; rgb[i * 3 + 2] = B[2] + v * 1.12;
    hgt[i] = wave[i] * o.wave + lines[i] * o.lines * 0.004 + g2 * 0.0012;
    rough[i] = o.rough + d * 0.12 + g * 0.03;
  }
  return {W, H, rgb, hgt, rough, pu, pv};
}

/* ================================================================ GLASS room atlas
   32 ft x 8 ft strip of interior back wall (x along the wall, y from floor to ceiling), 32 px per foot.
   A = albedo (wall paint, furniture, pictures, doorways, lamps); E = night emission (lamp pools, lit shades, hall light).
   The shader picks a different stretch of it, and a different wall tint, for every window. */
function roomAtlas(C){
  const W = 1024, H = 256, PX = W / 32;
  const A = C.canvas(W, H), E = C.canvas(W, H), a = A.getContext("2d"), e = E.getContext("2d");
  const rnd = C.rng(5150);
  const X = f => f * PX, Y = f => H - f * PX;
  const rgb = (r, g, b) => "rgb(" + (r | 0) + "," + (g | 0) + "," + (b | 0) + ")";
  a.fillStyle = "#d3cfc8"; a.fillRect(0, 0, W, H);
  e.fillStyle = "#1a1109"; e.fillRect(0, 0, W, H);
  const vg = a.createLinearGradient(0, 0, 0, H);
  vg.addColorStop(0, "rgba(0,0,0,0.10)"); vg.addColorStop(0.5, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(0,0,0,0.06)");
  a.fillStyle = vg; a.fillRect(0, 0, W, H);
  a.fillStyle = "#e6e4df"; a.fillRect(0, Y(0.38), W, X(0.38));               /* baseboard */
  a.fillStyle = "#b9b5ae"; a.fillRect(0, Y(0.4), W, 1);
  a.fillStyle = "#dcd9d3"; a.fillRect(0, 0, W, X(0.22));                     /* crown */
  function rect(c, x0, y0, x1, y1, col){ c.fillStyle = col; c.fillRect(X(x0), Y(y1), X(x1 - x0), X(y1 - y0)); }
  function glow(cx, cy, r, alpha){
    const g = e.createRadialGradient(X(cx), Y(cy), 0, X(cx), Y(cy), X(r));
    g.addColorStop(0, "rgba(255,186,112," + alpha + ")"); g.addColorStop(0.45, "rgba(255,170,96," + alpha * 0.35 + ")"); g.addColorStop(1, "rgba(255,160,90,0)");
    e.globalCompositeOperation = "lighter"; e.fillStyle = g; e.fillRect(X(cx - r), Y(cy + r), X(2 * r), X(2 * r)); e.globalCompositeOperation = "source-over";
  }
  function lamp(cx, base, h){
    /* table / floor lamp: base + pleated shade; lit shade and a light pool on the wall at night */
    rect(a, cx - 0.06, base, cx + 0.06, base + h * 0.55, "#5d5348");
    a.fillStyle = "#ece4d2"; a.beginPath();
    const s0 = base + h * 0.5, s1 = base + h;
    a.moveTo(X(cx - 0.75), Y(s0)); a.lineTo(X(cx + 0.75), Y(s0)); a.lineTo(X(cx + 0.5), Y(s1)); a.lineTo(X(cx - 0.5), Y(s1)); a.fill();
    glow(cx, s1, 3.4, 0.85); glow(cx, s0 - 0.3, 2.2, 0.5);
    e.fillStyle = "#ffd9a0"; e.beginPath();
    e.moveTo(X(cx - 0.75), Y(s0)); e.lineTo(X(cx + 0.75), Y(s0)); e.lineTo(X(cx + 0.5), Y(s1)); e.lineTo(X(cx - 0.5), Y(s1)); e.fill();
  }
  function picture(cx, cy, w, h){
    const fr = rnd() < 0.5 ? "#2a2522" : rnd() < 0.5 ? "#6b4e33" : "#c8c3b8";
    rect(a, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, fr);
    rect(a, cx - w / 2 + 0.12, cy - h / 2 + 0.12, cx + w / 2 - 0.12, cy + h / 2 - 0.12, "#e9e6df");
    const g = a.createLinearGradient(0, Y(cy + h / 2), 0, Y(cy - h / 2));
    g.addColorStop(0, rgb(90 + rnd() * 90, 100 + rnd() * 70, 110 + rnd() * 80)); g.addColorStop(1, rgb(60 + rnd() * 80, 70 + rnd() * 60, 50 + rnd() * 60));
    a.fillStyle = g; a.fillRect(X(cx - w / 2 + 0.28), Y(cy + h / 2 - 0.28), X(w - 0.56), X(h - 0.56));
    rect(e, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, "rgba(20,12,6,0.6)");
  }
  const SOFA = [[92, 98, 108], [128, 112, 96], [84, 90, 76], [150, 142, 128], [104, 76, 70]];
  let x = 0.4;
  const order = ["sofa", "door", "dresser", "shelf", "bed", "tv", "door", "chair", "sofa", "dresser"];
  for (let n = 0; x < 30.5; n++){
    const kind = order[n % order.length];
    if (kind === "sofa"){
      const w = 6 + rnd() * 1.5; if (x + w + 2 > 31.8) break;
      lamp(x + 0.9, 2.0, 1.9); rect(a, x + 0.2, 0, x + 1.6, 2.0, "#6f5640");
      const c = SOFA[(rnd() * SOFA.length) | 0], sx = x + 2;
      rect(a, sx, 0.3, sx + w, 2.9, rgb(c[0] * 0.8, c[1] * 0.8, c[2] * 0.8));
      rect(a, sx + 0.1, 1.2, sx + w - 0.1, 2.8, rgb(c[0], c[1], c[2]));
      rect(a, sx, 0.3, sx + 0.55, 2.2, rgb(c[0] * 0.9, c[1] * 0.9, c[2] * 0.9)); rect(a, sx + w - 0.55, 0.3, sx + w, 2.2, rgb(c[0] * 0.9, c[1] * 0.9, c[2] * 0.9));
      for (let k = 1; k < 3; k++) rect(a, sx + k * w / 3 - 0.02, 1.25, sx + k * w / 3 + 0.02, 2.75, rgb(c[0] * 0.65, c[1] * 0.65, c[2] * 0.65));
      rect(a, sx + 0.7, 2.0, sx + 1.7, 2.9, "#e8e2d2"); rect(a, sx + w - 1.7, 2.0, sx + w - 0.7, 2.85, "#b9a27c");
      rect(e, sx, 0.3, sx + w, 2.9, "rgba(18,10,5,0.85)");
      picture(sx + w / 2, 4.9, 2.6 + rnd(), 1.8 + rnd() * 0.6);
      x = sx + w + 0.8 + rnd();
    } else if (kind === "door"){
      if (x + 3.6 > 31.8) break;
      rect(a, x, 0, x + 3.4, 7.2, "#ece9e3");
      const g = a.createLinearGradient(0, Y(6.8), 0, Y(0));
      g.addColorStop(0, "#4a4540"); g.addColorStop(1, "#2f2b27"); a.fillStyle = g; a.fillRect(X(x + 0.3), Y(6.8), X(2.8), X(6.8));
      rect(a, x + 1.2, 0, x + 3.1, 6.8, "#57514a");
      rect(e, x + 0.3, 0, x + 3.1, 6.8, "#3a2410"); glow(x + 1.7, 5.5, 2.0, 0.35);
      x += 3.4 + 1.2 + rnd() * 1.5;
    } else if (kind === "dresser"){
      const w = 3.5 + rnd() * 1.6; if (x + w > 31.8) break;
      rect(a, x, 0.2, x + w, 2.8, "#71523a"); rect(a, x - 0.05, 2.7, x + w + 0.05, 2.85, "#5c4230");
      for (let k = 1; k < 4; k++) rect(a, x + 0.1, 0.2 + k * 0.62, x + w - 0.1, 0.22 + k * 0.62, "#4a3423");
      rect(e, x, 0.2, x + w, 2.85, "rgba(16,9,4,0.85)");
      if (rnd() < 0.5) lamp(x + w - 0.8, 2.85, 1.7);
      rect(a, x + w / 2 - 1.2, 3.6, x + w / 2 + 1.2, 6.2, "#3e3a36"); rect(a, x + w / 2 - 1.05, 3.75, x + w / 2 + 1.05, 6.05, "#8f979b");
      x += w + 0.9 + rnd() * 1.2;
    } else if (kind === "shelf"){
      if (x + 3.4 > 31.8) break;
      rect(a, x, 0, x + 3.2, 6.6, "#4e3a2a");
      for (let s = 0; s < 5; s++){
        const y0 = 0.5 + s * 1.2;
        let bx = x + 0.15;
        while (bx < x + 3.0){
          const bw = 0.08 + rnd() * 0.14, bh = 0.6 + rnd() * 0.4;
          rect(a, bx, y0, Math.min(bx + bw, x + 3.05), y0 + bh, rgb(70 + rnd() * 120, 60 + rnd() * 90, 50 + rnd() * 80));
          bx += bw + 0.01;
        }
      }
      rect(e, x, 0, x + 3.2, 6.6, "rgba(14,8,4,0.9)");
      x += 3.2 + 0.8 + rnd();
    } else if (kind === "bed"){
      const w = 5.4; if (x + w > 31.8) break;
      rect(a, x, 0.2, x + w, 4.0, "#5a4334"); rect(a, x + 0.2, 0.2, x + w - 0.2, 2.3, "#e4e0d8"); rect(a, x + 0.4, 2.0, x + 2.5, 2.6, "#f1eee7"); rect(a, x + 2.9, 2.0, x + w - 0.4, 2.6, "#f1eee7");
      rect(e, x, 0.2, x + w, 4.0, "rgba(16,9,4,0.85)");
      picture(x + w / 2, 5.4, 3.2, 1.4);
      lamp(x + w + 0.9, 2.2, 1.6); rect(a, x + w + 0.3, 0, x + w + 1.5, 2.2, "#6f5640");
      x += w + 2.2 + rnd();
    } else if (kind === "tv"){
      const w = 5; if (x + w > 31.8) break;
      rect(a, x, 0.2, x + w, 2.0, "#6a4d36"); rect(a, x + 0.7, 2.6, x + w - 0.7, 4.7, "#161616"); rect(a, x + 0.75, 2.65, x + w - 0.75, 4.65, "#22252a");
      rect(e, x, 0.2, x + w, 2.0, "rgba(16,9,4,0.85)"); rect(e, x + 0.75, 2.65, x + w - 0.75, 4.65, "#0b1626");
      x += w + 1 + rnd();
    } else {
      if (x + 3 > 31.8) break;
      rect(a, x, 0.2, x + 2.6, 3.2, rgb(110 + rnd() * 40, 100 + rnd() * 30, 86 + rnd() * 30));
      rect(e, x, 0.2, x + 2.6, 3.2, "rgba(16,9,4,0.85)");
      picture(x + 1.3, 5.0, 1.6, 2.0);
      a.fillStyle = "#4b5c3c"; a.beginPath(); a.ellipse(X(x + 3.4), Y(3.4), X(0.7), X(1.1), 0, 0, Math.PI * 2); a.fill();
      rect(a, x + 3.1, 0, x + 3.7, 1.6, "#7a5b44");
      x += 4.6 + rnd();
    }
  }
  /* ceiling fixtures (night) */
  for (let k = 0; k < 4; k++) glow(4 + k * 8 + rnd() * 2, 8.3, 4.5, 0.45);
  return {A, E};
}

/* ================================================================ DOOR (white full-view storm door, 36" x 81.6")
   Behind the glass: the white entry door in shade with raised panels and a half-round lite; reflections are neutral. */
function doorMaps(C){
  const W = 256, H = 512, N = W * H, pu = 36 / W, pv = 81.6 / H;
  const G = grit();
  const dirt = up(field(C, 32, 64, {octaves: 4, base: 3, sx: 1, sy: 2, seed: 61, persistence: 0.6}), W, H, "fa");
  const room = up(field(C, 32, 64, {octaves: 3, base: 3, sx: 1, sy: 2, seed: 62}), W, H, "fb");
  const rgb = buf("rgb", N * 3), hgt = buf("hgt", N), rough = buf("rough", N), metal = buf("metal", N, true);
  const WH = [229, 227, 222];
  const S = 3.0, TOP = 3.0, KICK = 10.5, RAIL = 13.0, BEAD = 0.45, DW = 36, DH = 81.6;
  for (let y = 0; y < H; y++){
    const yin = (H - 1 - y + 0.5) * pv, low = 10 * (1 - sstep(0, 9, yin));
    for (let x = 0; x < W; x++){
      const p = y * W + x, d = Math.max(0, dirt[p] + 0.15), gm = d * d * 30 + low * (0.5 + d), n = G[p] * 2.4;
      rgb[p * 3] = WH[0] - gm + n; rgb[p * 3 + 1] = WH[1] - gm * 1.04 + n; rgb[p * 3 + 2] = WH[2] - gm * 1.15 + n;
      hgt[p] = 0.5 + G[p + 333] * 0.0015; rough[p] = 0.42 + d * 0.1;
    }
  }
  function rect(x0, y0, x1, y1, fn){
    const ca = Math.max(0, Math.floor(x0 / pu)), cb = Math.min(W, Math.ceil(x1 / pu));
    const ra = Math.max(0, Math.floor(H - y1 / pv)), rb = Math.min(H, Math.ceil(H - y0 / pv));
    for (let y = ra; y < rb; y++){
      const yin = (H - 1 - y + 0.5) * pv; if (yin < y0 || yin >= y1) continue;
      for (let x = ca; x < cb; x++){ const xin = (x + 0.5) * pu; if (xin < x0 || xin >= x1) continue; fn(y * W + x, xin, yin); }
    }
  }
  function set(p, r, g, b, h, ro, me){ rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = b; hgt[p] = h; rough[p] = ro; metal[p] = me; }
  rect(S, RAIL, DW - S, DH - TOP, (p, xin, yin) => {
    const de = Math.min(xin - S, DW - S - xin, yin - RAIL, DH - TOP - yin);
    if (de < BEAD){ const f = 0.86; rgb[p * 3] *= f; rgb[p * 3 + 1] *= f; rgb[p * 3 + 2] *= f; hgt[p] = 0.5 - 0.25 * de / BEAD; return; }
    if (de < BEAD + 0.15){ set(p, 48, 48, 49, 0.18, 0.6, 0); return; }
    /* entry door behind the glass: white, in shade (~sRGB 130), soft bevels lit from above */
    const ix = Math.abs(xin - 18), side = xin < 18 ? -1 : 1;
    let v = 104 + room[p] * 10;
    let b = 0;
    const r2 = (xin - 18) * (xin - 18) + (yin - 60) * (yin - 60);
    if (yin > 60 && r2 < 81){                                         /* half-round lite: dark glass with a lit hall behind */
      const rr = Math.sqrt(r2);
      v = rr > 8.2 ? 104 : 74 + 24 * (yin - 60) / 9 + room[p] * 12; b = rr > 8.2 ? 0 : 8;
      if (rr <= 8.2 && (Math.abs(xin - 18) < 0.3 || Math.abs(Math.atan2(yin - 60, xin - 18) - Math.PI / 2) % 0.62 < 0.04)) v = 120;
    } else {
      const py0 = yin > 34 ? 36 : 17, py1 = yin > 34 ? 56 : 31;
      if (ix > 2 && ix < 12 && yin > py0 && yin < py1){
        const dl = ix - 2, dr = 12 - ix, db = yin - py0, dt = py1 - yin, pe = Math.min(dl, dr, db, dt);
        if (pe < 1.3){
          const f = pe === dt ? 1.06 : pe === db ? 0.9 : ((pe === dl) === (side > 0) ? 0.96 : 1.03);
          v *= f * (pe < 0.15 ? 0.88 : 1);
        } else v *= 1.03;
      }
      { const kr = Math.hypot(xin - 31, yin - 38); if (kr < 0.95){ const kv = 0.6 + 0.4 * Math.max(0, 1 - Math.hypot(xin - 30.75, yin - 38.3) / 0.8); set(p, 120 * kv, 98 * kv, 62 * kv, 0, 0.05, 0); return; } }   /* brass knob */
    }
    v *= 0.86 + 0.14 * sstep(13, 60, yin);
    /* faint diagonal sky sheen so the pane reads as glass even with nothing behind it */
    /* diagonal sky sheen (broad band + a thin bright streak) so the pane reads as glass even with nothing to reflect */
    const dg = ((DH - yin) * 0.55 + xin) / 52;
    const sheen = sstep(0.05, 0.6, dg) * (1 - sstep(0.62, 1.15, dg)) + 0.7 * Math.exp(-Math.pow((dg - 1.32) / 0.035, 2));
    const n = G[p] * 3;
    set(p, v - 2 + n + sheen * 12, v + n + sheen * 17, v + 3 + b + n + sheen * 24, 0, 0.05, 0);
  });
  rect(S, 0.55, DW - S, KICK, p => { hgt[p] = 0.45; });
  rect(S + 2, 2.5, DW - S - 2, KICK - 1.5, (p, xin, yin) => {
    const de = Math.min(xin - S - 2, DW - S - 2 - xin, yin - 2.5, KICK - 1.5 - yin);
    hgt[p] = 0.45 - 0.08 * sstep(0, 0.35, de);
  });
  rect(0, 0, DW, 0.55, p => set(p, 66 + G[p] * 6, 66 + G[p] * 6, 67 + G[p] * 6, 0.35, 0.85, 0));
  rect(33.85, 33.8, 34.95, 40.2, p => set(p, 46, 42, 38, 0.9, 0.32, 0.75));
  rect(33.95, 34.4, 34.45, 36.7, p => set(p, 36, 34, 32, 1.25, 0.28, 0.75));
  rect(34.1, 37.5, 34.7, 38.1, p => set(p, 150, 128, 84, 1.0, 0.25, 1));
  rect(0, 0, DW, DH, (p, xin, yin) => {
    const fr = Math.min(xin, DW - xin, yin, DH - yin);
    if (fr < 0.25){ hgt[p] -= (0.25 - fr) * 0.8; rgb[p * 3] *= 0.92; rgb[p * 3 + 1] *= 0.92; rgb[p * 3 + 2] *= 0.92; }
  });
  return {W, H, rgb, hgt, rough, metal, pu, pv};
}

/* ================================================================ STEEL
   galvanised (default): fine zinc spangle (~0.5"), soft cell edges, dull oxide patches, a few rust pin-points;
   painted (opts.steel === "painted"): grey enamel with orange peel, scuffs and a little rust at chips */
function steelMaps(C, painted){
  const W = 256, H = 512, N = W * H, pu = 12 / W, pv = 24 / H;
  const rnd = C.rng(8181), G = grit();
  const patch = up(field(C, 32, 64, {octaves: 4, base: 2, sx: 1, sy: 2, seed: 71, persistence: 0.5}), W, H, "fa");
  const streak = up(field(C, 64, 32, {octaves: 3, base: 10, sx: 1, sy: 0.25, seed: 72}), W, H, "fb");
  const rgb = buf("rgb", N * 3), hgt = buf("hgt", N), rough = buf("rough", N), metal = buf("metal", N, true);
  if (painted){
    const peel = up(field(C, 128, 256, {octaves: 2, base: 40, sx: 1, sy: 1, seed: 73}), W, H, "fc");
    for (let i = 0; i < N; i++){
      const ox = Math.max(0, patch[i] + 0.1);
      const v = 104 + streak[i] * 4 + G[i] * 3 - ox * 10;
      rgb[i * 3] = v; rgb[i * 3 + 1] = v + 3; rgb[i * 3 + 2] = v + 6;
      metal[i] = 0; rough[i] = 0.55 + ox * 0.15 + G[i] * 0.03; hgt[i] = peel[i] * 0.004 + G[i] * 0.0008;
    }
  } else {
    const CS = 0.5, gx = Math.round(12 / CS), gy = Math.round(24 / CS);
    const px = new Float32Array(gx * gy), py = new Float32Array(gx * gy), pt = new Float32Array(gx * gy);
    for (let i = 0; i < gx * gy; i++){ px[i] = rnd(); py[i] = rnd(); pt[i] = rnd() - 0.5; }
    for (let y = 0; y < H; y++){
      const fy = (y + 0.5) / H * gy, cy = Math.floor(fy);
      for (let x = 0; x < W; x++){
        const p = y * W + x;
        const fx = (x + 0.5) / W * gx, cx = Math.floor(fx);
        let best = 9, best2 = 9, tone = 0;
        for (let j = -1; j <= 1; j++){
          const iy = (cy + j + gy) % gy;
          for (let i = -1; i <= 1; i++){
            const ix = (cx + i + gx) % gx, c = iy * gx + ix;
            const ddx = cx + i + px[c] - fx, ddy = cy + j + py[c] - fy, dd = ddx * ddx + ddy * ddy;
            if (dd < best){ best2 = best; best = dd; tone = pt[c]; } else if (dd < best2) best2 = dd;
          }
        }
        const edge = sstep(0, 0.06, Math.sqrt(best2) - Math.sqrt(best));
        const ox = Math.max(0, patch[p] + 0.05);
        const v = 122 + tone * 3 * (1 - ox) + streak[p] * 3 + G[p] * 4 - (1 - edge) * 0.8 + ox * 5;
        rgb[p * 3] = v - 1; rgb[p * 3 + 1] = v + 1; rgb[p * 3 + 2] = v + 3;
        metal[p] = 0.5 - ox * 0.3;
        rough[p] = 0.48 + tone * 0.06 + ox * 0.2 + G[p] * 0.04;
        hgt[p] = (1 - edge) * -0.001 + streak[p] * 0.004 + G[p] * 0.0012;
      }
    }
  }
  for (let k = 0; k < 30; k++){
    const sx = Math.floor(rnd() * W), sy = Math.floor(rnd() * H), r = 1 + rnd() * 2;
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++){
      const dd = Math.hypot(i, j); if (dd > r) continue;
      const p = ((sy + j + H) % H) * W + (sx + i + W) % W, f = 0.6 + 0.35 * dd / r;
      rgb[p * 3] *= f; rgb[p * 3 + 1] *= f * 0.95; rgb[p * 3 + 2] *= f * 0.88; rough[p] = 0.75; metal[p] = 0.2;
    }
  }
  return {W, H, rgb, hgt, rough, metal, pu, pv};
}

/* ================================================================ public */
REAL.finish = {
  create: function(THREE, renderer, opts){
    opts = opts || {};
    const C = REAL.core;
    const seedAttr = !!opts.seedAttribute;
    const t0 = performance.now();
    const T = REAL.finish.timings = {}; let tl = t0;
    const lap = n => { const t = performance.now(); T[n] = +(t - tl).toFixed(1); tl = t; };
    function std(maps, o){
      const m = new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 1, metalness: maps.metal ? 1 : 0});
      m.map = C.texture(THREE, rgbCanvas(C, maps.W, maps.H, maps.rgb), {srgb: true});
      m.normalMap = C.texture(THREE, normalCanvas(C, maps.W, maps.H, maps.hgt, maps.pu, maps.pv, 1));
      m.normalScale = new THREE.Vector2(o.ns || 1, o.ns || 1);
      const rm = C.texture(THREE, dataCanvas(C, maps.W, maps.H, maps.rough, maps.metal || null, maps.mask || null));
      m.roughnessMap = rm; if (maps.metal) m.metalnessMap = rm;
      return finPatch(THREE, m, o.patch, seedAttr);
    }

    /* roof: 40" x 21.6" tile (4 courses); fragment UVs cut it into staggered shingles; macro weathering blotches ~9 ft */
    const shingle = std(shingleMaps(C), {patch: {tile: [3.33333, 1.8], downhill: true, frag: UV_SHINGLE, macro: [0.07, 0.13]}});
    lap("shingle");
    /* walls: 6 ft x 2 ft tile (4 boards); per-course row / offset / end lap in the shader; faint sun-fade variation */
    const siding = std(sidingMaps(C), {patch: {tile: [6, 2], frag: UV_SIDING, macro: [0.03, 0.09]}});
    lap("siding");
    /* trim: warm-white coil stock, satin; 2 ft x 12 ft tile along the piece, world-space grime and drip streaks */
    const trim = std(whiteMaps(C, {W: 128, H: 1024, inU: 24, inV: 144, seed: 81, base: [231, 229, 223], dirt: 0.45, lines: 0.4, wave: 0.03, rough: 0.42}),
                     {patch: {tile: [2, 12], grain: true, jit: [1, 1], macro: [0.05, 0.22], drip: 0.05, edge: [0.06, 0.2]}});
    lap("trim");
    /* frame: whiter, smoother, glossier vinyl */
    const frame = std(whiteMaps(C, {W: 128, H: 512, inU: 18, inV: 72, seed: 91, base: [232, 231, 227], dirt: 0.22, lines: 1, wave: 0.006, rough: 0.28}),
                      {patch: {tile: [1.5, 6], grain: true, jit: [1, 1], drip: 0.025, edge: [0.035, 0.12]}});
    lap("frame");

    /* glass: double-glazed dielectric (F0 ~0.08 via reflectivity); the interior is ray-traced in the shader */
    const room = roomAtlas(C);
    const glass = new THREE.MeshPhysicalMaterial({color: 0xffffff, roughness: 0.035, metalness: 0, reflectivity: 0.72});
    glass.map = C.texture(THREE, room.A, {srgb: true}); glass.map.wrapT = THREE.ClampToEdgeWrapping;
    glass.emissiveMap = C.texture(THREE, room.E, {srgb: true}); glass.emissiveMap.wrapT = THREE.ClampToEdgeWrapping;
    const wave = up(field(C, 32, 32, {octaves: 2, base: 2, seed: 53}), 256, 256);
    for (let i = 0; i < wave.length; i++) wave[i] *= 0.012;
    glass.normalMap = C.texture(THREE, normalCanvas(C, 256, 256, wave, 36 / 256, 48 / 256, 1));
    glass.normalScale = new THREE.Vector2(1, 1);
    glass.emissive = new THREE.Color(1, 1, 1);
    glass.emissiveIntensity = 0;            /* integrator raises this at night (about 1.2 - 2.5) */
    glass.shadowSide = THREE.BackSide;      /* thin pane: shadow-map its far face so the near face never self-shadows (acne) */
    finPatch(THREE, glass, {tile: [3, 4], jit: [1, 1], glass: true, refl: {k: 9.0}}, seedAttr);
    lap("glass");

    const door = std(doorMaps(C), {patch: {tile: [3, 6.8], refl: {k: 13.0, mask: true, neutral: 1}}});
    lap("door");
    const painted = opts.steel === "painted";
    const steel = std(steelMaps(C, painted), {patch: {tile: [1, 2], grain: true, jit: [1, 1], edge: [0.03, 0.18]}});
    lap("steel");

    POOL = {}; GRIT = null;                 /* release scratch memory */
    const ms = performance.now() - t0;
    REAL.finish.buildMs = ms;
    return {
      buildMs: ms,
      variants: {
        shingle: {material: shingle, sample: [12, 0.07, 0.9], rot: [0.6, 0, 0], spread: [0, 0.45, -0.75], count: 6, tile: [3.33333, 1.8],
                  note: "top face: courses run up from whichever long edge is DOWNHILL (auto-detected); a dark course line every 5.4in, two per 0.9 ft strip"},
        siding:  {material: siding, sample: [8, 0.5, 0.05], spread: [0, 0.5, 0], count: 8, tile: [6, 2],
                  note: "a lap butt every 0.5 ft up from the piece's bottom face; works as single boards or whole wall panels"},
        trim:    {material: trim, sample: [0.36, 6, 0.07], count: 3, spread: [0.62, 0, 0], tile: [2, 12]},
        frame:   {material: frame, sample: [0.17, 4, 0.24], count: 3, spread: [0.5, 0, 0], tile: [1.5, 6]},
        glass:   {material: glass, sample: [3, 4.5, 0.05], count: 3, spread: [3.4, 0, 0], tile: [3, 4],
                  note: "one box per window (both sashes): a room is ray-traced behind it, blinds hang from the pane's top; panes wider than 6 ft get two 2.34 ft flanking double-hungs. emissiveIntensity 0 by day, raise at night"},
        door:    {material: door, sample: [3, 6.8, 0.16], count: 1, tile: [3, 6.8], note: "one whole storm door per 3 x 6.8 ft face, no jitter"},
        steel:   {material: steel, sample: [0.3, 8, 0.3], tile: [1, 2]}
      }
    };
  }
};
})();
