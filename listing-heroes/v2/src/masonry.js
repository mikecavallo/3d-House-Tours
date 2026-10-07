/* REAL.masonry: procedural photoreal concrete, block, stucco and parge for the build.
   REAL.masonry.create(THREE, renderer, opts) -> { buildMs, variants: { concrete, concreteWet, cmu, stucco, parge, walk } }
   Every variant is { material, sample:[sx,sy,sz] (feet), optional spread, count } (sample/spread/count are lab hints).
   opts.res = 2 doubles the concrete/wet/walk maps to 1024 (about 4x their build time); default 1 = 512.
   All textures are generated with canvas 2D + REAL.core noise; deterministic (fixed seeds), no images.

   Each material is a core.material (world-scaled UVs) plus a shader patch (enhance()) that adds, in WORLD space:
     - macro variation: a 256px tileable noise texture sampled planar in world feet at four scales unrelated to the
       tile. Low-frequency tone lives here, not in the tile, so 3-4 ft repeats do not show on long slabs and walls;
     - sub-texel grain (256px, ~0.7 ft per repeat) for albedo, roughness and a derivative bump; it mips away at distance;
     - concrete: bugholes and form-lift lines only on vertical (formed) faces; tops get faint float marks instead.
       (The roughness map packs cavity in R, roughness in G (what three reads), lift in B.)
     - concreteWet: world-space bull-float arcs (mostly roughness), glossy bleed-water sheets on top faces, a
       per-pixel boost of reflected sky plus a procedural dark treeline in the reflection so the slab reads as
       wet; vertical faces (inside the forms) stay lighter and matte.
     - cmu: the map is a 2-block atlas; each block picks a cell and an optional mirror from a hash of its index, and
       gets its own tone and mottle, so no two neighbouring blocks share a face. Sampling uses analytic gradients,
       so there are no mip seams at the block boundaries.
     - walk: broom striations from a separate high-resolution texture, oriented across the walk on long pieces and
       along the nosing on narrow pieces (stair treads, < 1.6 ft deep). Risers and edges stay smooth.
     - parge: vertical stain streaks fade downward from the top of each piece (they come from the sill above), and
       the paint-wear hue shift is world-space (an in-tile one would repeat every 4 ft).
   Integration notes:
     - walk: a piece whose top face is narrower than 1.6 ft (a stair tread) gets its broom lines along its long side
       (parallel to the nosing); wider pieces get them across their long side (across the walk). No rotation needed.
     - concreteWet: the reflection boost/treeline only touch top faces; the look depends on the scene env map (rig).
     - all 512 maps share one noise pool built once per create(); every canvas is written straight into ImageData.
   Note: because the macro is world-anchored, a piece that is MOVED (not just revealed) slides under its macro
   pattern; per-block cmu choices use gl_InstanceID (WebGL2) so they stay put. */
(function(){
"use strict";
const REAL = window.REAL = window.REAL || {};

/* ---------------------------------------------------------------- helpers */
function sstep(a, b, x){ let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
function cl(v, a, b){ return v < a ? a : v > b ? b : v; }
/* index wrap for splats whose reach is always far smaller than the tile */
function wrap(v, n){ return v < 0 ? v + n : v >= n ? v - n : v; }
function wrapAny(v, n){ v %= n; return v < 0 ? v + n : v; }

/* uniform white noise -0.5..0.5 (xorshift32) */
function white(n, seed){
  const f = new Float32Array(n);
  let s = (Math.imul(seed | 0, 2654435761) | 0) || 1;
  for (let i = 0; i < n; i++){ s ^= s << 13; s ^= s >>> 17; s ^= s << 5; f[i] = (s >>> 0) / 4294967296 - 0.5; }
  return f;
}
/* tileable separable box blur (radius r px, wraps), `passes` times; ~gaussian after 2-3 passes */
function blur(f, W, H, r, passes){
  if (r < 1) return f;
  const tmp = new Float32Array(Math.max(W, H)), inv = 1 / (2 * r + 1);
  for (let p = 0; p < (passes || 1); p++){
    if (W > 1) for (let y = 0; y < H; y++){
      const row = y * W; let s = 0;
      for (let k = -r; k <= r; k++) s += f[row + ((k % W) + W) % W];
      for (let x = 0; x < W; x++){
        tmp[x] = s * inv;
        let a = x + r + 1; if (a >= W) a -= W;
        let b = x - r; if (b < 0) b += W;
        s += f[row + a] - f[row + b];
      }
      for (let x = 0; x < W; x++) f[row + x] = tmp[x];
    }
    if (H > 1) for (let x = 0; x < W; x++){
      let s = 0;
      for (let k = -r; k <= r; k++) s += f[(((k % H) + H) % H) * W + x];
      for (let y = 0; y < H; y++){
        tmp[y] = s * inv;
        let a = y + r + 1; if (a >= H) a -= H;
        let b = y - r; if (b < 0) b += H;
        s += f[a * W + x] - f[b * W + x];
      }
      for (let y = 0; y < H; y++) f[y * W + x] = tmp[y];
    }
  }
  return f;
}
/* zero mean, given standard deviation */
function stdNorm(f, sd){
  let m = 0; for (let i = 0; i < f.length; i++) m += f[i]; m /= f.length;
  let v = 0; for (let i = 0; i < f.length; i++){ const d = f[i] - m; v += d * d; }
  const k = sd / (Math.sqrt(v / f.length) || 1);
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - m) * k;
  return f;
}
/* low-res tileable fbm (-0.5..0.5) upsampled bilinearly (wrap) to W x H: far cheaper than full-res fbm */
function lowField(C, w, h, o){
  const f = C.normalize(C.fbm(w, h, o));
  for (let i = 0; i < f.length; i++) f[i] -= 0.5;
  return {f, w, h};
}
function up(F, W, H){
  const out = new Float32Array(W * H), w = F.w, h = F.h, f = F.f;
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
function field(C, W, H, lw, lh, o){ return up(lowField(C, lw, lh, o), W, H); }

/* canvases are written directly as ImageData (Uint8ClampedArray clamps and rounds on assignment) */
function px(C, W, H){ const c = C.canvas(W, H), ctx = c.getContext("2d"), img = ctx.createImageData(W, H); img.data.fill(255); return {c, ctx, img, d: img.data}; }
function flush(b){ b.ctx.putImageData(b.img, 0, 0); return b.c; }
/* tangent-space normal map (OpenGL convention, canvas top = +V) from a height field in INCHES.
   pu/pv = pixel size in inches, k = slope gain. tu/tv = feet per UV unit of the material's mapping: three's
   derivative tangent frame (perturbNormal2Arb) shortens the axis with the larger UV span by min/max, so that
   axis is pre-scaled here to keep slopes true on non-square tiles. */
function normalCanvas(C, W, H, hf, pu, pv, k, tu, tv){
  const b = px(C, W, H), d = b.d;
  const fx = tu && tv ? Math.max(1, tu / tv) : 1, fy = tu && tv ? Math.max(1, tv / tu) : 1;
  const sx = k * fx / (2 * pu), sy = k * fy / (2 * pv);
  for (let y = 0; y < H; y++){
    const ru = (y === 0 ? H - 1 : y - 1) * W, rd = (y === H - 1 ? 0 : y + 1) * W, row = y * W;
    for (let x = 0, i = row * 4; x < W; x++, i += 4){
      const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
      const nx = (hf[row + xl] - hf[row + xr]) * sx, ny = (hf[rd + x] - hf[ru + x]) * sy;
      const inv = 127.5 / Math.sqrt(nx * nx + ny * ny + 1);
      d[i] = 127.5 + nx * inv; d[i+1] = 127.5 + ny * inv; d[i+2] = 127.5 + inv;
    }
  }
  return flush(b);
}

/* a round pit (bughole / pore / void) splatted into height (inches) and cavity (0..1) buffers, wrapping */
function pit(hgt, cav, W, H, cx, cy, rx, ry, depth, dark, msk){
  const x0 = Math.floor(cx - rx - 1), x1 = Math.ceil(cx + rx + 1), y0 = Math.floor(cy - ry - 1), y1 = Math.ceil(cy + ry + 1);
  for (let y = y0; y <= y1; y++){
    const yy = wrap(y, H), dy = (y + 0.5 - cy) / ry, dy2 = dy * dy;
    if (dy2 >= 1.3) continue;
    for (let x = x0; x <= x1; x++){
      const dx = (x + 0.5 - cx) / rx, d2 = dx * dx + dy2;
      if (d2 >= 1.3) continue;
      const i = yy * W + wrap(x, W);
      if (d2 < 1){ const t = Math.sqrt(1 - d2); hgt[i] -= depth * t; const o = dark * Math.min(1, t * 2.2); if (o > cav[i]) cav[i] = o; }
      else { hgt[i] += depth * 0.12 * (1.3 - d2) / 0.3; }   /* tiny raised lip */
      if (msk) msk[i] = 1;
    }
  }
}
/* value of a field at the p-th quantile (0..1) via a 512-bin histogram; f is in 0..1 */
function quantile(f, p){
  const bins = new Uint32Array(512);
  for (let i = 0; i < f.length; i++) bins[Math.min(511, Math.max(0, (f[i] * 512) | 0))]++;
  let acc = 0; const target = p * f.length;
  for (let b = 0; b < 512; b++){ acc += bins[b]; if (acc >= target) return (b + 0.5) / 512; }
  return 1;
}

/* ---------------------------------------------------------------- world-space shader patch
   o = { key, s:[sR, sG, sB, sC] feet per repeat, a:[aR, aG, aB, aC] albedo amplitude, r:[rR, rB] roughness amplitude,
         d:[grainFeet, grainAlb, grainRough, grainBumpFeet],
         streakTop: feet over which the vertical streaks fade downward from the top of the piece (or 0 = full height),
         formed: {cav, lift}  cavity darkening and form-lift tone on vertical faces only (roughness map R/B),
         floatMarks: {s, rough, alb}  faint float passes on top faces (wet texture R),
         wet: {s, pud:[lo, hi], pudRough, pudDark, rough, bump, env:[sheen, puddle], vertAlb, vertRough, tree},
         block: {ju, tile:[u,v], tone, mot}  cmu atlas / mirror / per-block tone,
         broom: {tile, along, across, alb, rough, bump} }
   R = broad isotropic blotches, G = sparse darker vertical streaks (vertical faces only), B = medium breakup,
   C = R again, rotated, at a small scale. Four incommensurate scales so neither the tile nor the macro repeat shows. */
function bumpGLSL(tex, q, ch, scale){
  /* derivative bump (three's perturbNormalArb method); height in feet. Pixel-footprint derivatives make it fade
     out by itself once the detail is smaller than a pixel. */
  return `{
    vec2 mcrBx = dFdx(${q}), mcrBy = dFdy(${q});
    float mcrBh = texture2D(${tex}, ${q}).${ch};
    vec2 mcrDH = vec2(texture2D(${tex}, ${q} + mcrBx).${ch} - mcrBh, texture2D(${tex}, ${q} + mcrBy).${ch} - mcrBh) * (${scale});
    vec3 mcrSp = -vViewPosition;
    vec3 mcrSx = dFdx(mcrSp), mcrSy = dFdy(mcrSp);
    vec3 mcrR1 = cross(mcrSy, normal), mcrR2 = cross(normal, mcrSx);
    float mcrDet = dot(mcrSx, mcrR1) * faceDirection;
    vec3 mcrGrad = sign(mcrDet) * (mcrDH.x * mcrR1 + mcrDH.y * mcrR2);
    normal = normalize(abs(mcrDet) * normal - mcrGrad);
  }`;
}

function enhance(THREE, m, T, o){
  const dt = o.d || [0.8, 0.05, 0.03, 0];
  const f = v => (+v).toFixed(5);
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  const key = "mcr2:" + o.key;
  const Wt = o.wet, Fl = o.floatMarks, Bk = o.block, Br = o.broom, Fo = o.formed;
  m.onBeforeCompile = function(shader, renderer){
    if (prev) prev.call(this, shader, renderer);
    shader.uniforms.mcrMap = {value: T.macro};
    shader.uniforms.mcrGrain = {value: T.grain};
    if (Wt || Fl) shader.uniforms.mcrWet = {value: T.wet};
    if (Br) shader.uniforms.mcrBroom = {value: T.broom};
    shader.vertexShader = "varying vec3 vMcrW;\nvarying vec3 vMcrN;\nvarying vec3 vMcrI;\nvarying vec2 vMcrE;\n" +
      shader.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>
        vec4 mcrW4 = vec4(transformed, 1.0);
        vec3 mcrN3 = objectNormal;
        vec3 mcrS = vec3(1.0);
        vMcrI = vec3(0.0);
        #ifdef USE_INSTANCING
          mcrW4 = instanceMatrix * mcrW4;
          mcrN3 = mat3(instanceMatrix) * mcrN3;
          mcrS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          /* per-instance identity for the block hash: the instance index where available (stable if the piece is
             animated), else its position */
          #if __VERSION__ >= 300
            vMcrI = vec3(float(gl_InstanceID) * 1.618, 0.0, 0.0);
          #else
            vMcrI = instanceMatrix[3].xyz;
          #endif
        #endif
        vMcrW = (modelMatrix * mcrW4).xyz;
        vMcrN = normalize(mat3(modelMatrix) * mcrN3);
        /* x: feet below the top of the piece; y: 1 on the top face of a narrow piece (a stair tread) */
        vMcrE = vec2((0.5 - transformed.y) * mcrS.y, (abs(objectNormal.y) > 0.5 && min(mcrS.x, mcrS.z) < 1.6) ? 1.0 : 0.0);`);

    /* ---- fragment: declarations */
    let decl = "uniform sampler2D mcrMap;\nuniform sampler2D mcrGrain;\nvarying vec3 vMcrW;\nvarying vec3 vMcrN;\nvarying vec3 vMcrI;\nvarying vec2 vMcrE;\n";
    if (Wt || Fl) decl += "uniform sampler2D mcrWet;\n";
    if (Br) decl += "uniform sampler2D mcrBroom;\n";
    let mainStart = "";
    if (Bk){
      /* cmu: per-block atlas cell + mirror. mcrUv replaces vUv for the map, normal and roughness fetches;
         mcrGx/mcrGy are its true screen gradients (continuous across block boundaries), so mip selection and the
         normal-map tangent frame have no seams where the per-block offset jumps. */
      decl += `vec2 mcrUv; vec2 mcrGx; vec2 mcrGy;
        #if __VERSION__ >= 300
          #define mcrTex(s, q) textureGrad(s, q, mcrGx, mcrGy)
          #define mcrTexG(s, q, gx, gy) textureGrad(s, q, gx, gy)
        #else
          #define mcrTex(s, q) texture2D(s, q)
          #define mcrTexG(s, q, gx, gy) texture2D(s, q)
        #endif\n`;
      mainStart = `
        vec2 mcrBlk = floor(vUv);
        vec3 mcrBI = vec3(mcrBlk, 0.0) + floor(vMcrI * 3.0 + 0.5) * vec3(1.0, 7.0, 13.0);
        float mcrH = fract(sin(dot(mcrBI, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        float mcrH2 = fract(mcrH * 17.31 + 0.27), mcrH3 = fract(mcrH * 41.7 + 0.61), mcrH4 = fract(mcrH * 23.17 + 0.41), mcrH5 = fract(mcrH * 57.3 + 0.13);
        float mcrMs = mcrH5 < 0.5 ? 1.0 : -1.0;
        mcrUv = vec2(mcrMs > 0.0 ? vUv.x : 2.0 * mcrBlk.x + 1.0 + ${f(Bk.ju)} - vUv.x, (vUv.y - mcrBlk.y + step(0.5, mcrH4)) * 0.5);
        mcrGx = dFdx(vUv) * vec2(mcrMs, 0.5); mcrGy = dFdy(vUv) * vec2(mcrMs, 0.5);`;
    }

    /* ---- map stage */
    let mapCode = `
      vec3 mcrA = abs(vMcrN);
      vec2 mcrP = mcrA.y > 0.5 ? vMcrW.xz : (mcrA.x > 0.5 ? vec2(vMcrW.z, vMcrW.y) : vMcrW.xy);
      /* broad blotches: two incommensurate, rotated samples so the macro's own repeat never lines up */
      float mcrR = clamp(0.5 + (texture2D(mcrMap, mcrP * ${f(1 / o.s[0])} + vec2(0.13, 0.71)).r
                       + texture2D(mcrMap, mat2(0.799, -0.602, 0.602, 0.799) * mcrP * ${f(1 / (o.s[0] * 1.618))} + vec2(0.61, 0.07)).r - 1.0) * 0.75, 0.0, 1.0);
      float mcrG = texture2D(mcrMap, mcrP * ${f(1 / o.s[1])} + vec2(0.57, 0.29)).g;
      float mcrB = texture2D(mcrMap, vec2(mcrP.y, -mcrP.x) * ${f(1 / o.s[2])} + vec2(0.41, 0.83)).b;
      float mcrC = texture2D(mcrMap, mat2(0.8, 0.6, -0.6, 0.8) * mcrP * ${f(1 / o.s[3])} + vec2(0.23, 0.37)).r;
      float mcrVert = 1.0 - smoothstep(0.3, 0.7, mcrA.y);
      float mcrHz = 1.0 - mcrVert;
      float mcrTopF = smoothstep(0.6, 0.9, mcrA.y);
      float mcrStk = mcrVert * (mcrG - 0.5) * 2.0${o.streakTop ? ` * smoothstep(${f(o.streakTop)}, 0.0, vMcrE.x)` : ""};
      ${o.tint ? `diffuseColor.rgb *= 1.0 + vec3(${f(o.tint[0])}, ${f(o.tint[1])}, ${f(o.tint[2])}) * (mcrC - 0.5) * 2.0;` : ""}
      diffuseColor.rgb *= max(0.2, 1.0 + ${f(o.a[0])} * (mcrR - 0.5) * 2.0 + ${f(o.a[1])} * mcrStk + ${f(o.a[2])} * (mcrB - 0.5) * 2.0 + ${f(o.a[3])} * (mcrC - 0.5) * 2.0);
      vec2 mcrQ = mcrP * ${f(1 / dt[0])} + vec2(0.17, 0.53);
      vec4 mcrDt = texture2D(mcrGrain, mcrQ);
      diffuseColor.rgb *= 1.0 + ${f(dt[1])} * (mcrDt.r - 0.5) * 2.0;
      float mcrPud = 0.0;`;
    const WS = Wt ? Wt.s : Fl ? Fl.s : 14;
    if (Wt || Fl) mapCode += `
      vec2 mcrWq = mat2(0.921, 0.391, -0.391, 0.921) * mcrP * ${f(1 / WS)} + vec2(0.31, 0.77);
      vec4 mcrWt = texture2D(mcrWet, mcrWq);`;
    if (Wt) mapCode += `
      mcrPud = smoothstep(${f(Wt.pud[0])}, ${f(Wt.pud[1])}, mcrWt.g + (mcrR - 0.5) * 0.08 + (mcrB - 0.5) * 0.08) * mcrTopF;
      diffuseColor.rgb *= mix(1.0, ${f(Wt.vertAlb)}, mcrVert) * (1.0 - ${f(Wt.pudDark)} * mcrPud);`;
    if (Fl) mapCode += `
      diffuseColor.rgb *= 1.0 + ${f(Fl.alb)} * (mcrWt.r - 0.5) * 2.0 * mcrTopF;`;
    if (Bk) mapCode += `
      {
        /* per-block tone, tint and mottle on the block face only (not the mortar) */
        vec2 mcrF = fract(vUv);
        float mcrFace = smoothstep(${f(Bk.ju)}, ${f(Bk.ju * 1.15)}, mcrF.x) * (1.0 - smoothstep(${f(1 - Bk.jv * 1.15)}, ${f(1 - Bk.jv)}, mcrF.y));
        vec3 mcrTone = vec3(1.0 + (mcrH - 0.5) * ${f(Bk.tone)}) * vec3(1.0 + (mcrH2 - 0.5) * 0.035, 1.0, 1.0 - (mcrH2 - 0.5) * 0.035);
        mcrTone *= 1.0 - step(0.93, mcrH3) * 0.07;   /* the odd noticeably darker block */
        vec2 mcrBw = vUv * vec2(${f(Bk.tile[0])}, ${f(Bk.tile[1])});
        vec2 mcrBg = vec2(${f(Bk.tile[0])}, ${f(Bk.tile[1])});
        float mcrMo = mcrTexG(mcrMap, mcrBw * 0.37 + vec2(mcrH4, mcrH5) * 3.7, dFdx(vUv) * mcrBg * 0.37, dFdy(vUv) * mcrBg * 0.37).r;
        float mcrMo2 = mcrTexG(mcrMap, mcrBw * 0.83 + vec2(mcrH2, mcrH3) * 2.3, dFdx(vUv) * mcrBg * 0.83, dFdy(vUv) * mcrBg * 0.83).b;
        mcrTone *= 1.0 + (mcrMo - 0.5) * ${f(Bk.mot)} + (mcrMo2 - 0.5) * ${f(Bk.mot * 0.5)};
        diffuseColor.rgb *= mix(vec3(1.0), mcrTone, mcrFace);
      }`;
    if (Br) mapCode += `
      vec2 mcrBq = (vMcrE.y > 0.5 ? vUv.yx : vUv) * vec2(${f(Br.tile / Br.along)}, ${f(Br.tile / Br.across)}) + vec2(0.37, 0.11);
      vec4 mcrBt = texture2D(mcrBroom, mcrBq);
      diffuseColor.rgb *= 1.0 + ${f(Br.alb)} * (mcrBt.r - 0.5) * 2.0 * mcrTopF;`;

    /* ---- roughness stage */
    let roughCode = `
      roughnessFactor = roughnessFactor + ${f(o.r[0])} * (mcrR - 0.5) * 2.0 + ${f(o.r[1])} * (mcrB - 0.5) * 2.0 + ${f(dt[2])} * (mcrDt.g - 0.5) * 2.0;`;
    if (Fo) roughCode += `
      float mcrCav = texelRoughness.r;
      diffuseColor.rgb *= mix(1.0, (1.0 - ${f(Fo.cav)} * mcrCav) * (1.0 + ${f(Fo.lift)} * (texelRoughness.b - 0.5) * 2.0), mcrVert);`;
    if (Fl) roughCode += `
      roughnessFactor += ${f(Fl.rough)} * (mcrWt.r - 0.5) * 2.0 * mcrTopF;`;
    if (Wt) roughCode += `
      roughnessFactor += (${f(Wt.rough)} * (mcrWt.r - 0.5) * 2.0 + 0.06 * mcrWt.b) * mcrTopF;
      roughnessFactor = mix(roughnessFactor, ${f(Wt.vertRough)}, mcrVert);
      /* the film only turns mirror-like once it is continuous: a narrower band for roughness than for darkening,
         so a film edge never gets a dull ring of in-between roughness in the glare */
      float mcrPudR = smoothstep(0.42, 0.82, mcrPud);
      roughnessFactor = mix(roughnessFactor, ${f(Wt.pudRough)}, mcrPudR);`;
    if (Br) roughCode += `
      roughnessFactor += ${f(Br.rough)} * (mcrBt.g - 0.5) * 2.0 * mcrTopF;`;
    roughCode += `
      roughnessFactor = clamp(roughnessFactor, 0.03, 1.0);`;

    /* ---- normal stage */
    let normCode = "";
    if (dt[3] > 0) normCode += bumpGLSL("mcrGrain", "mcrQ", "b", f(dt[3]));
    if (Br) normCode += bumpGLSL("mcrBroom", "mcrBq", "b", `${f(Br.bump)} * mcrTopF`);
    if (Wt) normCode += bumpGLSL("mcrWet", "mcrWq", "b", `${f(Wt.bump)} * mcrTopF * (1.0 - mcrPud)`) +
      "\n normal = normalize(mix(normal, geometryNormal, mcrPudR * 0.95));";
    if (Fo) normCode += "\n normal = normalize(mix(normal, geometryNormal, clamp(mcrCav * 20.0, 0.0, 1.0) * mcrHz));";

    /* ---- reflected light stage (wet only): the rig's dome has no reflected detail, so the wet top gets more of
       the sky and a ragged dark treeline near the horizon of its reflection (the site is wooded all round) */
    let lightCode = "";
    if (Wt) lightCode = `
      #if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
      {
        vec3 mcrRw = inverseTransformDirection(reflect(-geometry.viewDir, geometry.normal), viewMatrix);
        float mcrAz = atan(mcrRw.z, mcrRw.x);
        float mcrTl = 0.15 + 0.035 * sin(mcrAz * 5.0 + 1.3) + 0.025 * sin(mcrAz * 11.0 + 0.4) + 0.012 * sin(mcrAz * 29.0 + 2.1);
        float mcrTw = 0.012 + material.specularRoughness * 0.3;
        float mcrTree = (1.0 - smoothstep(mcrTl - mcrTw, mcrTl + mcrTw, mcrRw.y)) * ${f(Wt.tree)};
        radiance = mix(radiance, vec3(0.030, 0.038, 0.028), mcrTree * mcrTopF);
        radiance *= 1.0 + (mix(${f(Wt.env[0])}, ${f(Wt.env[1])}, mcrPud) - 1.0) * mcrTopF;
        #if NUM_DIR_LIGHTS > 0
          /* bleed water is never a perfect mirror: micro-ripples spread the sun into a bright glint + aureole.
             directLight still holds the (shadowed) sun from the light loop. */
          float mcrSc = max(dot(reflect(-geometry.viewDir, geometry.normal), directLight.direction), 0.0);
          radiance += directLight.color * (pow(mcrSc, 400.0) * ${f(Wt.glint[0])} + pow(mcrSc, 8.0) * ${f(Wt.glint[1])}) * mcrPudR;
        #endif
      }
      #endif`;

    let fs = decl + shader.fragmentShader
      .replace("void main() {", "void main() {\n" + mainStart)
      .replace("#include <map_fragment>", "#include <map_fragment>\n" + mapCode)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + roughCode)
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + normCode)
      .replace("#include <lights_fragment_maps>", "#include <lights_fragment_maps>\n" + lightCode);
    if (Bk){
      const SC = THREE.ShaderChunk;
      const sub = s => s.replace(/texture2D\(\s*(map|normalMap|roughnessMap)\s*,\s*vUv\s*\)/g, "mcrTex($1, mcrUv)")
                        .replace(/dFdx\(\s*vUv\.st\s*\)/g, "mcrGx").replace(/dFdy\(\s*vUv\.st\s*\)/g, "mcrGy");
      ["map_fragment", "roughnessmap_fragment", "normal_fragment_maps", "normalmap_pars_fragment"].forEach(n => {
        fs = fs.replace("#include <" + n + ">", sub(SC[n]));
      });
    }
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = function(){ return (prevKey ? prevKey.call(this) : "") + key; };
  m.userData.macro = o;
  m.needsUpdate = true;
  return m;
}

/* ---------------------------------------------------------------- shared world-space textures */
/* 256px RGBA tileable macro noise (linear data): R blotches, G vertical streaks, B medium breakup; + grain map */
function makeMacro(C, THREE){
  const S = 256, N = S * S;
  /* fields whose finest lattice fits in 128px are built there and upsampled (values -0.5..0.5 -> 0..1) */
  const lo = o => { const f = field(C, S, S, 128, 128, o); for (let i = 0; i < N; i++) f[i] += 0.5; return f; };
  const r = lo({base: 3, octaves: 5, persistence: 0.55, seed: 9101});
  const g = C.normalize(C.fbm(S, S, {base: 3, sx: 14, sy: 0.67, octaves: 3, persistence: 0.45, seed: 9102}));
  const gm = lo({base: 3, sx: 3, sy: 1, octaves: 3, persistence: 0.5, seed: 9104});
  const b = lo({base: 6, octaves: 4, persistence: 0.55, seed: 9103});
  const M = px(C, S, S), d = M.d;
  for (let i = 0, k = 0; i < N; i++, k += 4){
    /* soft contrast so blotches read as patches rather than a uniform haze;
       G is 0.5 (neutral) except in sparse runs of darker streaks: weathering only ever darkens */
    d[k] = sstep(0.1, 0.9, r[i]) * 255; d[k+1] = (0.5 - 0.5 * sstep(0.5, 0.86, g[i]) * sstep(0.45, 0.78, gm[i])) * 255; d[k+2] = sstep(0.1, 0.9, b[i]) * 255;
  }
  /* grain: R = sand-size albedo grain (fine + 2px clumps), G = independent grain for roughness, B = grain height
     for the detail bump; all mean 0.5 so they vanish into the mip chain at distance */
  const gr = stdNorm(white(N, 9111), 0.16), gc = stdNorm(blur(white(N, 9112), S, S, 1, 1), 0.12), gg = stdNorm(blur(white(N, 9113), S, S, 1, 1), 0.2);
  const gh = stdNorm(blur(white(N, 9114), S, S, 1, 1), 0.17);
  const G = px(C, S, S), d2 = G.d;
  for (let i = 0, k = 0; i < N; i++, k += 4){ d2[k] = (0.5 + gr[i] + gc[i]) * 255; d2[k+1] = (0.5 + gg[i]) * 255; d2[k+2] = (0.5 + gh[i] + gr[i] * 0.3) * 255; }
  return {macro: C.texture(THREE, flush(M)), grain: C.texture(THREE, flush(G))};
}

/* Fresh-pour surface, 256px for 14 ft (sampled in world space, rotated 23 deg):
   R = bull-float passes (each pass leaves a slightly different gloss; later passes overwrite earlier ones),
   G = low-spot field for bleed-water sheets (quantiles returned for ~15-20% coverage), B = soft ridges at pass edges. */
function makeWetTex(C, THREE){
  const S = 256, N = S * S, ft = S / 14;
  const fl = new Float32Array(N), rid = new Float32Array(N);
  const rnd = C.rng(9201);
  for (let k = 0; k < 20; k++){
    const ox = rnd() * S, oy = rnd() * S, R0 = (4.5 + rnd() * 2.5) * ft, hw = (1.5 + rnd() * 0.35) * ft;
    const th = rnd() * 6.2832, half = 0.35 + rnd() * 0.3, tone = rnd() - 0.5, rw = 0.22 * ft, soft = 0.45 * ft;
    const cdx = Math.cos(th), cdy = Math.sin(th), cH = Math.cos(half), cH2 = Math.cos(half * 0.7);
    const Rin = R0 - hw - 2.5 * soft, Rout = R0 + hw + 2.5 * soft, Rin2 = Rin * Rin, Rout2 = Rout * Rout;
    const mx = ox + cdx * R0, my = oy + cdy * R0, ext = Math.max(Rout * Math.sin(half), Rout - Rin * cH) + 2;
    for (let y = Math.floor(my - ext); y <= Math.ceil(my + ext); y++){
      const dy = y + 0.5 - oy, row = wrapAny(y, S) * S, dy2 = dy * dy;
      for (let x = Math.floor(mx - ext); x <= Math.ceil(mx + ext); x++){
        const dx = x + 0.5 - ox, r2 = dx * dx + dy2;
        if (r2 < Rin2 || r2 > Rout2) continue;
        const r = Math.sqrt(r2), ca = (dx * cdx + dy * cdy) / r;
        if (ca < cH) continue;
        const wa = sstep(cH, cH2, ca), e = Math.abs(r - R0) - hw;
        const inside = sstep(soft, -soft, e) * wa, ridge = Math.exp(-(e / rw) * (e / rw)) * wa;
        const i = row + wrapAny(x, S);
        fl[i] = fl[i] * (1 - inside) + inside * tone;
        rid[i] = rid[i] * (1 - inside * 0.7) + ridge * 0.7;
      }
    }
  }
  blur(fl, S, S, 2, 2); blur(rid, S, S, 1, 2);
  const pud = C.normalize(C.fbm(S, S, {base: 4, octaves: 3, persistence: 0.42, seed: 9202}));
  const q = [quantile(pud, 0.80), quantile(pud, 0.9)];
  const B = px(C, S, S), d = B.d;
  for (let i = 0, k = 0; i < N; i++, k += 4){ d[k] = (0.5 + fl[i] * 0.9) * 255; d[k+1] = pud[i] * 255; d[k+2] = rid[i] * 255; }
  const t = C.texture(THREE, flush(B));
  t.mcrQ = q;
  return t;
}

/* Broom striations, 256 (along the stroke, 2 ft) x 512 (across, 1 ft = 0.023 in/px). Bristle grooves every
   1/16-1/8 in with random depth, grouped into clumps; the strokes wander a little and fade in and out along their
   length. R = albedo, G = roughness, B = height. */
function makeBroom(C, THREE){
  const W = 256, H = 512, N = W * H, rnd = C.rng(9301);
  const prof = new Float32Array(H);
  for (let y = 0; y < H; ){
    const depth = 0.35 + rnd() * 0.65, wd = 0.8 + rnd() * 1.3, yr = Math.round(y);
    for (let d = -5; d <= 5; d++){ const t = (d - (y - yr)) / wd; prof[(yr + d + H) % H] -= depth * Math.exp(-t * t); }
    y += 2.0 + rnd() * 2.8;
  }
  const grp = stdNorm(blur(white(H, 9304), 1, H, 7, 3), 1);
  for (let y = 0; y < H; y++) prof[y] = prof[y] * (0.75 + 0.35 * grp[y]) + grp[y] * 0.2;
  stdNorm(prof, 0.3);
  const wob = field(C, W, H, 32, 64, {base: 2, sx: 1, sy: 4, octaves: 3, seed: 9302});
  const amp = field(C, W, H, 64, 256, {base: 3, sx: 1, sy: 10, octaves: 3, seed: 9303});
  const B = px(C, W, H), d = B.d;
  for (let y = 0, i = 0, k = 0; y < H; y++){
    for (let x = 0; x < W; x++, i++, k += 4){
      let yy = y + wob[i] * 22; yy -= Math.floor(yy / H) * H;
      const y0 = yy | 0, ty = yy - y0, y1 = y0 + 1 === H ? 0 : y0 + 1;
      const h = (prof[y0] + (prof[y1] - prof[y0]) * ty) * cl(0.7 + amp[i] * 1.8, 0.15, 1.25) * 1.25;
      d[k] = (0.5 + h * 0.5) * 255; d[k+1] = (0.5 - h * 0.5) * 255; d[k+2] = (0.5 + h * 0.5) * 255;
    }
  }
  return C.texture(THREE, flush(B));
}

/* shared 512^2 noise pool: white grain, 2px sand, 4px clumps and two mottles, reused by every 512 map so they are
   generated once per build (different materials never sit in the same place with the same tile, so sharing is
   invisible) */
function makePool(C){
  const W = 512, N = W * W;
  return {
    W,
    fine: stdNorm(white(N, 106), 0.25),
    sand: stdNorm(blur(white(N, 105), W, W, 1, 1), 0.25),
    coarse: stdNorm(blur(white(N, 203), W, W, 2, 2), 0.25),
    mott: field(C, W, W, 128, 128, {base: 3, octaves: 5, persistence: 0.55, seed: 101}),
    mott2: field(C, W, W, 128, 128, {base: 9, octaves: 4, persistence: 0.5, seed: 102})
  };
}

function mat(C, THREE, W, H, A, Rg, hgt, pu, pv, o){
  return C.material(THREE, Object.assign({
    map: flush(A), normalMap: normalCanvas(C, W, H, hgt, pu, pv, o.nk || 1, o.tile[0], o.tileV || o.tile[1]), normalScale: 1,
    roughnessMap: flush(Rg), roughness: 1
  }, o));
}

/* ---------------------------------------------------------------- cast-in-place concrete (shared by cured + wet) */
function concreteFields(C, R, P){
  const W = 512 * R, H = W, N = W * H, Tin = 48, p = Tin / W, own = R !== 1;
  const mott = own ? field(C, W, H, 128, 128, {base: 3, octaves: 5, persistence: 0.55, seed: 101}) : P.mott;
  const mott2 = own ? field(C, W, H, 128, 128, {base: 9, octaves: 4, persistence: 0.5, seed: 102}) : P.mott2;
  const warm = field(C, W, H, 64, 64, {base: 2, octaves: 3, seed: 103});
  const lift = field(C, W, H, 64, 128, {base: 2, sx: 0.5, sy: 7, octaves: 3, seed: 108});   /* long along U: form-board marks */
  const sand = own ? stdNorm(blur(white(N, 105), W, H, 1, 1), 0.25) : P.sand;
  const fine = own ? stdNorm(white(N, 106), 0.25) : P.fine;
  const pitH = new Float32Array(N), cav = new Float32Array(N), agg = new Float32Array(N), pitM = new Uint8Array(N);
  const rnd = C.rng(107);
  /* faint aggregate ghosting: rounded stones just under the paste, lighter or darker */
  for (let k = 0; k < 500; k++){
    const cx = rnd() * W, cy = rnd() * H, r = (0.15 + Math.pow(rnd(), 2) * 0.4) / p, asp = 0.6 + rnd() * 0.6;
    const tone = (rnd() - 0.6) * 0.35, x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r), ry = r * asp, y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
    for (let y = y0; y <= y1; y++){
      const yy = wrap(y, H), dy = (y + 0.5 - cy) / ry;
      for (let x = x0; x <= x1; x++){
        const dx = (x + 0.5 - cx) / r, d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        agg[yy * W + wrap(x, W)] += tone * sstep(1, 0.4, d2);
      }
    }
  }
  /* bugholes (formed faces): strongly clustered (air trapped in patches), many pinholes, some 1/8-1/4", rare 1/2" */
  const tries = [[3000, 0.02, 0.04, 0.03, 0.35], [500, 0.04, 0.08, 0.06, 0.55], [60, 0.08, 0.16, 0.1, 0.7], [6, 0.16, 0.26, 0.15, 0.75]];
  for (const [n, r0, r1, dep, dk] of tries){
    for (let k = 0; k < n; k++){
      const cx = rnd() * W, cy = rnd() * H, i = (cy | 0) * W + (cx | 0);
      if (mott2[i] * 1.6 + mott[i] * 0.5 + (rnd() - 0.5) * 0.35 < 0.12) continue;
      const r = (r0 + rnd() * (r1 - r0)) / p, asp = 0.65 + rnd() * 0.5;
      pit(pitH, cav, W, H, cx, cy, Math.max(0.55, r), Math.max(0.55, r * asp), dep * (0.6 + rnd() * 0.6), dk, pitM);
    }
  }
  return {W, H, N, p, mott, mott2, warm, lift, sand, fine, pitH, cav, agg, pitM};
}

function makeConcrete(C, THREE, F, T){
  const {W, H, N, p} = F, A = px(C, W, H), Rg = px(C, W, H), a = A.d, rr = Rg.d, hgt = new Float32Array(N);
  const B = [150, 149, 144];
  for (let i = 0, k = 0; i < N; i++, k += 4){
    const m = F.mott[i], m2 = F.mott2[i], s = F.sand[i], ag = F.agg[i], wv = F.warm[i], fn = F.fine[i], cv = F.cav[i];
    /* low-frequency tone is kept small here (it would repeat every 4 ft); the world-space macro carries it */
    const L = 1 + m * 0.006 + m2 * 0.006 + s * 0.035 + fn * 0.03 + ag * 0.065;
    a[k] = B[0] * L * (1 + wv * 0.012); a[k+1] = B[1] * L; a[k+2] = B[2] * L * (1 - wv * 0.015);
    hgt[i] = m * 0.03 + m2 * 0.012 + s * 0.006 + fn * 0.002 + ag * 0.006 + F.pitH[i];
    /* roughness map: R = bughole cavity (>= 0.05 over the whole pit incl. its lip, so tops can flatten it),
       G = roughness, B = form-lift tone (cavity and lift are applied on vertical faces only) */
    rr[k] = Math.max(cv, F.pitM[i] * 0.05) * 255; rr[k+1] = (0.87 + s * 0.06 + fn * 0.04 + cv * 0.1) * 255; rr[k+2] = (0.5 + F.lift[i]) * 255;
  }
  const mt = mat(C, THREE, W, H, A, Rg, hgt, p, p, {tile: [4, 4], grain: "none", nk: 1});
  return enhance(THREE, mt, T, {key: "concrete", s: [13.7, 13.9, 5.3, 2.9], a: [0.06, 0.05, 0.04, 0.035], r: [0.04, 0.03], d: [0.75, 0.12, 0.05, 0.0006],
    formed: {cav: 0.55, lift: 0.03}, floatMarks: {s: 14, rough: 0.05, alb: 0.012}});
}

function makeConcreteWet(C, THREE, F, T){
  const {W, H, N, p} = F, A = px(C, W, H), Rg = px(C, W, H), a = A.d, rr = Rg.d, hgt = new Float32Array(N);
  const B = [80, 80, 78];
  const peel = field(C, W, H, 128, 128, {base: 28, octaves: 2, persistence: 0.5, seed: 113});
  for (let i = 0, k = 0; i < N; i++, k += 4){
    const m = F.mott[i], m2 = F.mott2[i], s = F.sand[i], wv = F.warm[i];
    /* matte where the surface has started to stiffen and sand shows; glossy paste elsewhere (smooth, so the 4 ft
       tile does not print in the gloss). Float passes and bleed water are world-space, in the shader patch. */
    const matte = cl(0.5 + m2 * 1.2, 0, 1);
    const L = 1 + m * 0.012 + m2 * 0.012 + s * 0.03 + F.agg[i] * 0.025 + matte * 0.012;
    a[k] = B[0] * L * (1 + wv * 0.01); a[k+1] = B[1] * L; a[k+2] = B[2] * L * (1 - wv * 0.01);
    hgt[i] = m * 0.02 + peel[i] * 0.008 + s * (0.002 + matte * 0.005) + F.fine[i] * 0.0008;
    const rv = (0.3 + s * 0.05 + matte * 0.06 + F.fine[i] * 0.03 + peel[i] * 0.05) * 255;
    rr[k] = rv; rr[k+1] = rv; rr[k+2] = rv;
  }
  const mt = mat(C, THREE, W, H, A, Rg, hgt, p, p, {tile: [4, 4], grain: "none", nk: 1});
  const q = T.wet.mcrQ;
  return enhance(THREE, mt, T, {key: "wet", s: [11.3, 9.1, 4.7, 2.6], a: [0.04, 0.0, 0.03, 0.02], r: [0.06, 0.04], d: [0.75, 0.02, 0.04, 0],
    wet: {s: 14, pud: [q[0] - 0.04, q[1] + 0.03], pudRough: 0.04, pudDark: 0.3, rough: 0.05, bump: 0.0008, env: [1.6, 2.4],
      vertAlb: 1.9, vertRough: 0.8, tree: 1, glint: [6.0, 1.4]}});
}

/* ---------------------------------------------------------------- CMU block wall
   One block = 16" x 7.846" (0.6538 ft). Bed joint along the TOP edge, head joint along the LEFT edge, both 3/8".
   The map is a 2-cell atlas (two different block faces stacked vertically, 512 x 2*256); the shader picks a cell
   and an optional left-right mirror per block (the face/joint layout is symmetric under that mirror), giving four
   distinct faces, and adds per-block tone + mottle on top. */
function makeCMU(C, THREE, T, P){
  const W = 512, CH = 256, H = CH * 2, N = W * H, Win = 16, Hin = 0.6538 * 12, pu = Win / W, pv = Hin / CH, px_ = (pu + pv) / 2, J = 0.375;
  const A = px(C, W, H), Rg = px(C, W, H), a = A.d, rr = Rg.d, hgt = new Float32Array(N);
  const g1 = P.sand, g0 = P.fine, g2 = P.coarse, mott = P.mott;
  const edgeN = field(C, W, H, 256, 256, {base: 20, octaves: 3, seed: 205});
  const pitH = new Float32Array(N), cav = new Float32Array(N);
  const rnd = C.rng(206);
  /* surface voids of the block face: many 0.5-1.5 mm, a few 2-4 mm, clustered in open patches. Light cavity
     darkening: the normal map carries most of their read */
  const dens = field(C, W, H, 64, 64, {base: 6, octaves: 3, seed: 207});
  for (let k = 0; k < 4400; k++){
    const x = rnd() * W, y = rnd() * H, r = (0.01 + Math.pow(rnd(), 3) * 0.06);
    if (dens[(y | 0) * W + (x | 0)] + (rnd() - 0.5) * 0.5 < -0.02) continue;
    pit(pitH, cav, W, H, x, y, Math.max(0.55, r / pu), Math.max(0.55, r * (0.6 + rnd() * 0.6) / pv), 0.02 + r * 0.5, 0.08 + r * 1.6);
  }
  const BL = [146, 145, 140], MO = [150, 147, 140];
  for (let y = 0; y < H; y++){
    const cell = y >= CH ? 1 : 0, Y = (y - cell * CH + 0.5) * pv, poreB = cell ? 0.03 : -0.02;
    let ay = Math.abs(Y - J / 2); if (ay > Hin / 2) ay = Hin - ay;
    for (let x = 0, i = y * W, k = i * 4; x < W; x++, i++, k += 4){
      const X = (x + 0.5) * pu;
      let ax = Math.abs(X - J / 2); if (ax > Win / 2) ax = Win - ax;
      const en = edgeN[i] * 0.09 + g2[i] * 0.04;
      const sdx = ax - J / 2 + en, sdy = ay - J / 2 + en * 0.8;
      const sd = Math.min(sdx, sdy);              /* signed distance into the block face (in) */
      const wf = cl(sd / px_ + 0.5, 0, 1);        /* face coverage */
      /* block face: open texture = fine clusters of tiny voids, coarse sand (tone variation is per block, in the shader) */
      const pore = sstep(0.14 + poreB, 0.32 + poreB, -g1[i] - g2[i] * 0.5);
      const arr = sd < 0.1 ? 0.045 * Math.pow(1 - cl(sd, 0, 0.1) / 0.1, 2) : 0;
      const fh = g1[i] * 0.01 + g0[i] * 0.005 + g2[i] * 0.01 + mott[i] * 0.02 - pore * 0.018 + pitH[i] - arr;
      const fL = (1 + g1[i] * 0.05 + g0[i] * 0.04 + g2[i] * 0.04 + mott[i] * 0.015) * (1 - 0.1 * pore) * (1 - 0.5 * cav[i]) * (1 - arr * 3);
      /* mortar: tooled concave joint, sandy, shadowed under the arrises; the bed joint's upper half sits under
         the overhanging arris of the block above, so it is baked a little darker (light comes from above) */
      const t = cl((sd + J / 2) / (J / 2), 0, 1);
      const mh = -0.14 + 0.07 * t * t + g1[i] * 0.005 + g0[i] * 0.004;
      const under = sdy < sdx ? cl(1 - Y / J, 0, 1) : 0;
      const mL = (1 + g1[i] * 0.05 + g0[i] * 0.05 + mott[i] * 0.05) * (0.9 - 0.22 * t * t * t) * (1 - 0.18 * under);
      hgt[i] = mh + (fh - mh) * wf;
      const L = mL + (fL - mL) * wf;
      a[k] = (MO[0] + (BL[0] - MO[0]) * wf) * L; a[k+1] = (MO[1] + (BL[1] - MO[1]) * wf) * L; a[k+2] = (MO[2] + (BL[2] - MO[2]) * wf) * L;
      const rm = 0.86 + g1[i] * 0.05, rv = (rm + ((0.93 + g0[i] * 0.04 + pore * 0.04) - rm) * wf) * 255;
      rr[k] = rv; rr[k+1] = rv; rr[k+2] = rv;
    }
  }
  const mt = mat(C, THREE, W, H, A, Rg, hgt, pu, pv, {tile: [1.3333, 0.6538], tileV: 1.3076, grain: "none", jitter: 0, nk: 1});
  return enhance(THREE, mt, T, {key: "cmu", s: [10.7, 13.3, 2.37, 5.1], a: [0.05, 0.08, 0.04, 0.03], r: [0.02, 0.02], d: [0.65, 0.07, 0.03, 0.0009],
    block: {ju: J / Win, jv: J / Hin, tile: [1.3333, 0.6538], tone: 0.16, mot: 0.15}});
}

/* ---------------------------------------------------------------- stucco (chimney): sand float / light knock-down over block */
const SINL = (() => { const n = 4096, t = new Float32Array(n); for (let i = 0; i < n; i++) t[i] = Math.sin(i / n * 6.283185307); return t; })();
function makeStucco(C, THREE, T, P){
  const W = 512, H = 512, N = W * H, Tin = 36, p = Tin / W;
  const A = px(C, W, H), Rg = px(C, W, H), a = A.d, rr = Rg.d, hgt = new Float32Array(N);
  const sand = P.sand, g0 = P.fine, mott = P.mott;
  const blob = field(C, W, H, 256, 256, {base: 40, octaves: 1, seed: 303});
  const blob2 = field(C, W, H, 128, 128, {base: 12, octaves: 3, persistence: 0.5, seed: 304});
  const swirl = new Float32Array(N);
  const rnd = C.rng(306);
  /* float swirls: arcs of fine concentric scratches swept by a 4" float */
  for (let k = 0; k < 16; k++){
    const cx = rnd() * W, cy = rnd() * H, R0 = (3.5 + rnd() * 5) / p, band = (1.3 + rnd() * 1.1) / p;
    const th = rnd() * 6.2832, half = 0.6 + rnd() * 0.9, cmx = Math.cos(th), cmy = Math.sin(th), ch = Math.cos(half), ch2 = Math.cos(half * 0.55);
    const sp = (0.12 + rnd() * 0.08) / p, amp = 0.5 + rnd() * 0.5, Rm = R0 + band, Ri = Math.max(0, R0 - band), kL = 4096 / sp, ib = 1 / band;
    /* walk only the annulus: per row, the outer chord minus the inner chord */
    for (let y = Math.floor(cy - Rm); y <= Math.ceil(cy + Rm); y++){
      const yy = wrap(y, H), dy = y + 0.5 - cy, dy2 = dy * dy;
      if (dy2 > Rm * Rm) continue;
      const xo = Math.sqrt(Rm * Rm - dy2), xi = dy2 < Ri * Ri ? Math.sqrt(Ri * Ri - dy2) : -1;
      for (let x = Math.floor(cx - xo); x <= Math.ceil(cx + xo); x++){
        const dx = x + 0.5 - cx;
        if (dx > -xi && dx < xi) { x = Math.ceil(cx + xi - 0.5) - 1; continue; }   /* next x has dx >= xi */
        const r2 = dx * dx + dy2;
        if (r2 > Rm * Rm) continue;
        const r = Math.sqrt(r2), ca = (dx * cmx + dy * cmy) / r;
        if (ca < ch) continue;
        const wr = 1 - Math.abs(r - R0) * ib;
        if (wr <= 0) continue;
        swirl[yy * W + wrap(x, W)] += SINL[((r * kL) | 0) & 4095] * amp * wr * wr * sstep(ch, ch2, ca);
      }
    }
  }
  /* faint block coursing ghosting through (7.2" courses, 18" units, half bond): soft, bed joints stronger */
  const course = 7.2, unit = 18;
  const B = [117, 100, 106];
  for (let y = 0; y < H; y++){
    const Y = (y + 0.5) * p, ci = Math.floor(Y / course), dyc = Math.abs(Y - (ci + 0.5) * course);
    const jy = sstep(course / 2 - 0.6, course / 2, dyc), off = (ci % 2) * unit / 2;
    for (let x = 0, i = y * W, k = i * 4; x < W; x++, i++, k += 4){
      const X = (x + 0.5) * p + off;
      const dxc = Math.abs((X % unit) - unit / 2), jx = sstep(unit / 2 - 0.6, unit / 2, dxc) * 0.5;
      const b2 = blob2[i], m = mott[i], s = sand[i], g = g0[i];
      const joint = Math.max(jy, jx) * cl(0.6 + b2 * 2, 0, 1);
      /* light knock-down: small flattened pads (~1/2-1") with sandy crevices between them */
      const isl = sstep(-0.02, 0.05, blob[i] + b2 * 0.3 + s * 0.1);
      const sw = swirl[i] * (0.5 + isl * 0.5);
      /* darker troweled smears where the float pressed the paste (reference chimney), lighter dry sand on the pads */
      const smear = sstep(0.05, 0.24, b2 + m * 0.4 + blob[i] * 0.35 - s * 0.12);
      hgt[i] = isl * 0.016 + s * 0.013 + g * 0.006 + sw * 0.004 + m * 0.015 + b2 * 0.02 - joint * 0.014 - smear * 0.006;
      const L = (1 + m * 0.05 + b2 * 0.05 + s * 0.12 + g * 0.08 + sw * 0.015) * (0.97 + isl * 0.05) * (1 - smear * 0.05) * (1 - joint * 0.06);
      a[k] = B[0] * L; a[k+1] = B[1] * L * (1 - m * 0.02); a[k+2] = B[2] * L;
      const rv = (0.9 + s * 0.05 - isl * 0.03 + g * 0.03 - smear * 0.05) * 255;
      rr[k] = rv; rr[k+1] = rv; rr[k+2] = rv;
    }
  }
  const mt = mat(C, THREE, W, H, A, Rg, hgt, p, p, {tile: [3, 3], grain: "none", nk: 1});
  return enhance(THREE, mt, T, {key: "stucco", s: [9.3, 12.7, 4.1, 2.3], a: [0.10, 0.18, 0.07, 0.08], r: [0.02, 0.02], d: [0.7, 0.08, 0.03, 0.0009]});
}

/* ---------------------------------------------------------------- parge (painted foundation band)
   512 x 256 over 48" x 30". Colour: the photos' mauve-grey-brown (R:G:B ~ 1 : 0.84 : 0.83), clearly darker than the
   chimney. Block coursing (8" x 16", half bond) telegraphs softly where the coat is thin. */
function makeParge(C, THREE, T, P){
  const W = 512, H = 256, N = W * H, Win = 48, Hin = 30, pu = Win / W, pv = Hin / H;
  const A = px(C, W, H), Rg = px(C, W, H), a = A.d, rr = Rg.d, hgt = new Float32Array(N);
  const sand = P.sand, g0 = P.fine;   /* the first 256 rows of the 512 pool (white-ish noise: no visible seam) */
  const und = field(C, W, H, 128, 64, {base: 5, sx: 1, sy: 0.63, octaves: 4, persistence: 0.5, seed: 403});
  const mott = field(C, W, H, 128, 64, {base: 3, sx: 1, sy: 0.63, octaves: 5, persistence: 0.55, seed: 404});
  const lump = field(C, W, H, 128, 128, {base: 14, sx: 1, sy: 0.63, octaves: 3, persistence: 0.5, seed: 405});
  const trow = new Float32Array(N), tw = new Float32Array(N);
  const rnd = C.rng(406);
  /* trowel passes: slightly tilted flat planes; a soft ridge where the blade edge lifted */
  for (let k = 0; k < 24; k++){
    const cx = rnd() * W, cy = rnd() * H, th = (rnd() - 0.5) * 1.4;
    const len = (8 + rnd() * 10), wid = (3.5 + rnd() * 2), ct = Math.cos(th), st = Math.sin(th), tilt = (rnd() - 0.5) * 0.01;
    const Ri = Math.hypot(len, wid) / 2 + 0.6, Ry = Ri / pv, hl = len / 2 + 0.6, hw = wid / 2 + 0.6;
    for (let y = Math.floor(cy - Ry); y <= Math.ceil(cy + Ry); y++){
      const yy = wrapAny(y, H), dyi = (y + 0.5 - cy) * pv;
      /* exact x-span of the rotated rectangle on this row: |dx ct + dy st| <= hl and |-dx st + dy ct| <= hw */
      let lo = -1e9, hi = 1e9;
      if (Math.abs(ct) > 1e-6){ const a0 = (-hl - dyi * st) / ct, a1 = (hl - dyi * st) / ct; lo = Math.max(lo, Math.min(a0, a1)); hi = Math.min(hi, Math.max(a0, a1)); }
      else if (Math.abs(dyi * st) > hl) continue;
      if (Math.abs(st) > 1e-6){ const b0 = (dyi * ct - hw) / st, b1 = (dyi * ct + hw) / st; lo = Math.max(lo, Math.min(b0, b1)); hi = Math.min(hi, Math.max(b0, b1)); }
      else if (Math.abs(dyi * ct) > hw) continue;
      if (lo > hi) continue;
      for (let x = Math.floor(cx + lo / pu); x <= Math.ceil(cx + hi / pu); x++){
        const dxi = (x + 0.5 - cx) * pu, aa = dxi * ct + dyi * st, b = -dxi * st + dyi * ct;
        const ea = len / 2 - Math.abs(aa), eb = wid / 2 - Math.abs(b);
        if (ea < -0.6 || eb < -0.6) continue;
        const i = yy * W + wrapAny(x, W);
        const inside = sstep(-0.1, 0.8, Math.min(ea, eb));
        const rb = (eb + 0.2) / 0.45, ridge = rb > -3 && rb < 3 ? Math.exp(-rb * rb) * sstep(-0.5, 1.5, ea) : 0;
        trow[i] = trow[i] * (1 - inside * 0.8) + inside * (b * tilt) + ridge * 0.0045;
        tw[i] = Math.max(tw[i] * (1 - inside * 0.5), inside);
      }
    }
  }
  const course = 8, unit = 16;
  const B = [86, 74, 75];
  for (let y = 0; y < H; y++){
    const Y = (y + 0.5) * pv, ci = Math.floor(Y / course), dyc = Math.abs(Y - (ci + 0.5) * course);
    const dj = (course / 2 - dyc) / 0.85, jy = Math.exp(-dj * dj), off = (ci % 2) * unit / 2;
    for (let x = 0, i = y * W, k = i * 4; x < W; x++, i++, k += 4){
      const X = (x + 0.5) * pu + off;
      const dxc = Math.abs((X % unit) - unit / 2), dk = (unit / 2 - dxc) / 0.85, jx = Math.exp(-dk * dk) * 0.6;
      const u = und[i], m = mott[i], lu = lump[i], s = sand[i], g = g0[i], tv = tw[i];
      /* the block joints only telegraph (soft and broken) where the parge coat is thin */
      const joint = Math.max(jy, jx) * sstep(-0.05, 0.3, u * 1.2 + m * 0.6 + lu * 0.3);
      const lp = sstep(0.05, 0.3, lu);
      /* troweled areas are flatter and slightly smoother; lumps and sand show between passes */
      const flat = 1 - tv * 0.6;
      hgt[i] = u * 0.035 + trow[i] + (lp * 0.03 + lu * 0.02) * flat + s * 0.014 * flat + g * 0.005 - joint * 0.02;
      const L = (1 + m * 0.035 + s * 0.07 * flat + g * 0.05 + u * 0.015 + lu * 0.03) * (1 - joint * 0.055) * (1 + tv * 0.01);
      /* paint wear around the mauve (redder-brown vs greyer) is mostly world-space (shader tint); a trace here */
      const w = u + m * 0.5;
      a[k] = B[0] * L * (1 + w * 0.012); a[k+1] = B[1] * L; a[k+2] = B[2] * L * (1 + w * 0.004);
      const rv = (0.8 + s * 0.04 * flat + m * 0.06 + g * 0.03 - tv * 0.06) * 255;
      rr[k] = rv; rr[k+1] = rv; rr[k+2] = rv;
    }
  }
  const mt = mat(C, THREE, W, H, A, Rg, hgt, pu, pv, {tile: [4, 2.5], grain: "none", nk: 1});
  return enhance(THREE, mt, T, {key: "parge", s: [11.1, 12.1, 3.7, 2.1], a: [0.10, 0.09, 0.06, 0.05], r: [0.03, 0.02], d: [0.8, 0.07, 0.04, 0.0006], streakTop: 2.0,
    tint: [0.05, 0.0, 0.012]});
}

/* ---------------------------------------------------------------- broom-finished walk / steps
   Weathered, buff concrete; worn patches where fine aggregate shows. The broom striations come from the shared
   broom texture in the shader (see header), so the base map is isotropic. */
function makeWalk(C, THREE, T, R, P){
  const W = 512 * R, H = W, N = W * H, Tin = 48, p = Tin / W, own = R !== 1;
  const A = px(C, W, H), Rg = px(C, W, H), a = A.d, rr = Rg.d, hgt = new Float32Array(N);
  const g0 = own ? stdNorm(white(N, 501), 0.25) : P.fine;
  const g1 = own ? stdNorm(blur(white(N, 502), W, H, 1, 1), 0.25) : P.sand;
  const mott = own ? field(C, W, H, 128, 128, {base: 3, octaves: 5, persistence: 0.55, seed: 503}) : P.mott;
  const wear = field(C, W, H, 128, 128, {base: 5, octaves: 4, persistence: 0.55, seed: 504});
  const agg = new Float32Array(N), aggH = new Float32Array(N), aggW = new Float32Array(N);
  const rnd = C.rng(509);
  /* aggregate exposed only in worn patches: sand-to-pea-size stones, greys and tans, low contrast */
  for (let k = 0; k < 3200; k++){
    const cx = rnd() * W, cy = rnd() * H, wv = wear[(cy | 0) * W + (cx | 0)];
    if (wv + (rnd() - 0.5) * 0.25 < 0.08) continue;
    const r = Math.max(0.6, (0.03 + Math.pow(rnd(), 2.2) * 0.14) / p), ry = r * (0.55 + rnd() * 0.5);
    const u = rnd(), tone = u < 0.45 ? -(0.03 + rnd() * 0.06) : u < 0.7 ? (0.02 + rnd() * 0.05) : -(0.01 + rnd() * 0.05);
    const warmS = u < 0.45 ? (rnd() - 0.5) * 0.02 : u < 0.7 ? 0.0 : 0.03 + rnd() * 0.05;
    const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1), y0 = Math.floor(cy - ry - 1), y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++){
      const yy = wrap(y, H), dy = (y + 0.5 - cy) / ry;
      for (let x = x0; x <= x1; x++){
        const dx = (x + 0.5 - cx) / r, d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const i = yy * W + wrap(x, W), c = sstep(1, 0.4, d2);
        agg[i] = agg[i] * (1 - c) + tone * c; aggW[i] = aggW[i] * (1 - c) + warmS * c;
        aggH[i] = Math.max(aggH[i], Math.sqrt(1 - d2) * 0.012);
      }
    }
  }
  const B = [171, 160, 141];
  for (let i = 0, k = 0; i < N; i++, k += 4){
    const wm = sstep(0.0, 0.2, wear[i]), g = g0[i], s = g1[i];
    /* sand grains: pixel-scale speckle, a little darker and warmer than the paste; more of it in worn patches */
    const sp = g > 0.3 - wm * 0.08 ? -0.05 : (g < -0.36 ? 0.03 : 0);
    const L = 1 + mott[i] * 0.035 + s * 0.04 + g * 0.02 + agg[i] + sp - wm * 0.025;
    const warmA = aggW[i] + 0.01 + wm * 0.01;
    a[k] = B[0] * L * (1 + warmA); a[k+1] = B[1] * L; a[k+2] = B[2] * L * (1 - warmA * 1.3);
    hgt[i] = mott[i] * 0.02 + s * (0.004 + wm * 0.004) + aggH[i] + g * 0.002;
    const rv = (0.9 + s * 0.04 + g * 0.03 + (agg[i] !== 0 ? -0.04 : 0.0)) * 255;
    rr[k] = rv; rr[k+1] = rv; rr[k+2] = rv;
  }
  const mt = mat(C, THREE, W, H, A, Rg, hgt, p, p, {tile: [4, 4], grain: "long", nk: 1});
  return enhance(THREE, mt, T, {key: "walk", s: [15.3, 9.1, 5.9, 2.7], a: [0.07, 0.0, 0.05, 0.03], r: [0.03, 0.02], d: [0.75, 0.06, 0.03, 0],
    broom: {tile: 4, along: 2, across: 1, alb: 0.05, rough: 0.06, bump: 0.0045}});
}

/* ---------------------------------------------------------------- public */
REAL.masonry = {
  create: function(THREE, renderer, opts){
    opts = opts || {};
    const C = REAL.core, R = opts.res || 1;
    const t0 = performance.now(), Tm = {}; let tl = t0;
    const lap = k => { const n = performance.now(); Tm[k] = Math.round(n - tl); tl = n; };
    const T = makeMacro(C, THREE); lap("macro");
    T.wet = makeWetTex(C, THREE); lap("wetTex");
    T.broom = makeBroom(C, THREE); lap("broom");
    const P = makePool(C); lap("pool");
    const F = concreteFields(C, R, P); lap("concreteFields");
    const concrete = makeConcrete(C, THREE, F, T); lap("concrete");
    const concreteWet = makeConcreteWet(C, THREE, F, T); lap("concreteWet");
    const cmu = makeCMU(C, THREE, T, P); lap("cmu");
    const stucco = makeStucco(C, THREE, T, P); lap("stucco");
    const parge = makeParge(C, THREE, T, P); lap("parge");
    const walk = makeWalk(C, THREE, T, R, P); lap("walk");
    const ms = performance.now() - t0;
    REAL.masonry.buildMs = ms; REAL.masonry.timing = Tm;
    return {
      buildMs: ms,
      variants: {
        concrete:    {material: concrete,    sample: [6, 0.8, 2], spread: [6.4, 0, 0], count: 2},
        concreteWet: {material: concreteWet, sample: [6, 0.8, 2], spread: [6.4, 0, 0], count: 2},
        cmu:         {material: cmu,         sample: [4, 0.6538, 0.667], spread: [0, 0.6538, 0], count: 6},
        stucco:      {material: stucco,      sample: [2.4, 8, 5], count: 1},
        parge:       {material: parge,       sample: [8, 2.5, 0.1], count: 1},
        walk:        {material: walk,        sample: [4, 0.1, 6], count: 1}
      }
    };
  }
};
})();
