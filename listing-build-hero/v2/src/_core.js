/* REAL core: shared helpers for the photoreal build.
   Everything hangs off window.REAL; modules are plain scripts (no ES modules) that need THREE (r128) loaded first. */
(function(){
"use strict";
const REAL = window.REAL = window.REAL || {};
const core = REAL.core = {};

/* deterministic RNG so every visit builds the same textures */
core.rng = function(seed){
  let s = seed | 0;
  return function(){
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};

core.canvas = function(w, h){
  const c = document.createElement("canvas");
  c.width = w; c.height = h || w;
  return c;
};

/* Tileable fractal value noise. Returns Float32Array(w*h) in ~0..1, periodic in both axes.
   base = lattice cells across the tile at the first octave; sx/sy stretch the lattice (sx>1 = more cells across x). */
core.fbm = function(w, h, o){
  o = o || {};
  const octaves = o.octaves || 5, base = o.base || 4, pers = o.persistence == null ? 0.5 : o.persistence;
  const sx = o.sx || 1, sy = o.sy || 1, rnd = core.rng(o.seed || 1);
  const out = new Float32Array(w * h);
  let amp = 1, total = 0;
  for (let k = 0; k < octaves; k++){
    const gx = Math.max(1, Math.round(base * sx * Math.pow(2, k))), gy = Math.max(1, Math.round(base * sy * Math.pow(2, k)));
    const lat = new Float32Array(gx * gy);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < h; y++){
      const fy = y / h * gy, y0 = Math.floor(fy), ty = fy - y0, y1 = (y0 + 1) % gy;
      const uy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < w; x++){
        const fx = x / w * gx, x0 = Math.floor(fx), tx = fx - x0, x1 = (x0 + 1) % gx;
        const ux = tx * tx * (3 - 2 * tx);
        const a = lat[y0 * gx + x0], b = lat[y0 * gx + x1], c = lat[y1 * gx + x0], d = lat[y1 * gx + x1];
        out[y * w + x] += amp * ((a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy);
      }
    }
    total += amp; amp *= pers;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
};

/* stretch a field's contrast to 0..1 */
core.normalize = function(f){
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++){ if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
  const r = hi - lo || 1;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) / r;
  return f;
};

/* paint a field into a canvas with a colour function v -> [r,g,b] (0..255) or [r,g,b,a] */
core.paint = function(field, w, h, fn, canvas){
  const c = canvas || core.canvas(w, h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h), d = img.data;
  for (let i = 0; i < w * h; i++){
    const px = fn(field ? field[i] : 0, i % w, (i / w) | 0);
    d[i*4] = px[0]; d[i*4+1] = px[1]; d[i*4+2] = px[2]; d[i*4+3] = px.length > 3 ? px[3] : 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
};

/* read a canvas back as a luminance height field (0..1) */
core.heightFromCanvas = function(c){
  const w = c.width, h = c.height, d = c.getContext("2d").getImageData(0, 0, w, h).data;
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = (d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114) / 255;
  return f;
};

/* tileable height field -> tangent-space normal map canvas (OpenGL convention, green = up) */
core.normalFromHeight = function(f, w, h, strength){
  const s = strength == null ? 2 : strength;
  return core.paint(null, w, h, (v, x, y) => {
    const xl = (x - 1 + w) % w, xr = (x + 1) % w, yu = (y - 1 + h) % h, yd = (y + 1) % h;
    const dx = (f[y*w + xr] - f[y*w + xl]) * 0.5 * s * (w / 256);
    const dy = (f[yu*w + x] - f[yd*w + x]) * 0.5 * s * (h / 256);
    let nx = -dx, ny = -dy, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    return [(nx*0.5+0.5)*255, (ny*0.5+0.5)*255, (nz*0.5+0.5)*255];
  });
};

/* canvas -> repeating texture. colour maps must pass {srgb:true}; data maps (normal, roughness) must not */
core.texture = function(THREE, canvas, o){
  o = o || {};
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (o.srgb) t.encoding = THREE.sRGBEncoding;
  t.anisotropy = core.maxAniso || 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
};

/* World-scaled UVs for InstancedMesh boxes.
   Box pieces are unit cubes scaled per instance, so stock UVs would stretch a texture across every board.
   This patch rescales each face's UVs to the instance's real size in feet, divides by `tile` (feet per texture repeat),
   optionally turns the texture so its V axis (grain direction) follows the face's longest side, and offsets each
   instance by a hash of its position so neighbouring boards don't share identical grain.
   opts: { tile:[uFeet, vFeet], grain:"long" | "none", jitter: 0..1 } */
core.worldUV = function(material, opts){
  opts = opts || {};
  const tile = opts.tile || [1, 1], grain = opts.grain === "long" ? 1 : 0, jitter = opts.jitter == null ? 1 : opts.jitter;
  const key = "wuv:" + tile.join(",") + ":" + grain + ":" + jitter;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function(shader, renderer){
    if (prev) prev.call(this, shader, renderer);
    shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>", `
      #ifdef USE_UV
        vec2 rUv = uv;
        #ifdef USE_INSTANCING
          vec3 wuvS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vec3 wuvN = abs(normal);
          vec2 wuvD = wuvN.x > 0.5 ? vec2(wuvS.z, wuvS.y) : (wuvN.y > 0.5 ? vec2(wuvS.x, wuvS.z) : vec2(wuvS.x, wuvS.y));
          vec2 wuvP = uv * wuvD;
          if (${grain}.0 > 0.5 && wuvD.x > wuvD.y) wuvP = vec2(uv.y * wuvD.y, uv.x * wuvD.x);
          vec3 wuvI = instanceMatrix[3].xyz;
          float wuvH = fract(sin(dot(floor(wuvI * 2.31 + 0.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          rUv = wuvP / vec2(${tile[0].toFixed(5)}, ${tile[1].toFixed(5)}) + vec2(wuvH, fract(wuvH * 7.13)) * ${jitter.toFixed(3)};
        #endif
        vUv = ( uvTransform * vec3( rUv, 1 ) ).xy;
      #endif`);
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function(){ return (prevKey ? prevKey.call(this) : "") + key; };
  material.needsUpdate = true;
  return material;
};

/* convenience: build a MeshStandardMaterial from canvases and patch it for world UVs */
core.material = function(THREE, o){
  const m = new THREE.MeshStandardMaterial({
    color: o.color == null ? 0xffffff : o.color,
    roughness: o.roughness == null ? 0.8 : o.roughness,
    metalness: o.metalness || 0
  });
  if (o.map) m.map = core.texture(THREE, o.map, {srgb:true});
  if (o.normalMap){ m.normalMap = core.texture(THREE, o.normalMap); m.normalScale = new THREE.Vector2(o.normalScale || 1, o.normalScale || 1); }
  if (o.roughnessMap) m.roughnessMap = core.texture(THREE, o.roughnessMap);
  if (o.alphaMap){ m.alphaMap = core.texture(THREE, o.alphaMap); m.alphaTest = o.alphaTest || 0.5; m.side = THREE.DoubleSide; }
  if (o.envMapIntensity != null) m.envMapIntensity = o.envMapIntensity;
  if (o.tile) core.worldUV(m, {tile:o.tile, grain:o.grain, jitter:o.jitter});
  return m;
};
})();
