/* DepthCam: fly a virtual camera through a single photo plus its disparity map.
   Each pixel's ray is marched through the depth map (parallax occlusion), so foreground
   objects slide over the background as the camera moves. WebGL2, no libraries.

   Coordinates: x right, y up, z forward (into the photo). The photo was taken from the origin
   looking down +z. Disparity d in [0,1] (1 = nearest) maps to depth Z = 1 / (NEAR + d*(1-NEAR)). */
(function(){
"use strict";
const NEAR = 0.06;              // d = 0 (sky) sits at Z = 16.7
const F = 1.35;                 // photo focal length, image half-height = 1

const VS = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v = p*0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const SCENE_FS = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D uImg, uDep;
uniform vec2 uRes;
uniform float uAsp, uF, uZoom, uNear;
uniform vec3 uCam;
uniform mat3 uRot;
uniform float uExpo;
float Zof(float d){ return 1.0/(uNear + d*(1.0 - uNear)); }
float dOf(float z){ return clamp((1.0/z - uNear)/(1.0 - uNear), 0.0, 1.0); }
vec2 uvOf(vec3 P){ vec2 q = uF*P.xy/P.z; return vec2(q.x/uAsp, q.y)*0.5 + 0.5; }
void main(){
  float va = uRes.x/uRes.y;
  float cover = min(1.0, uAsp/va);
  vec2 s = (v*2.0 - 1.0)*vec2(va, 1.0)*cover;
  vec3 rd = uRot*vec3(s/(uF*uZoom), 1.0);
  rd /= max(rd.z, 1e-3);
  float d0 = dOf(max(uCam.z + 0.04, 1.0));   /* nearest surface the camera can still see */
  const int N = 56;
  float prevD = d0, hitD = 0.0; bool hit = false;
  for (int i = 1; i <= N; i++){
    float dr = d0*(1.0 - float(i)/float(N));
    vec3 P = uCam + rd*(Zof(dr) - uCam.z);
    float ds = texture(uDep, uvOf(P)).r;
    if (ds >= dr){ hitD = dr; hit = true; break; }
    prevD = dr;
  }
  float lo = hit ? hitD : 0.0, hi = hit ? prevD : 0.0;
  for (int k = 0; k < 6; k++){
    float m = 0.5*(lo + hi);
    vec3 P = uCam + rd*(Zof(m) - uCam.z);
    if (texture(uDep, uvOf(P)).r >= m) lo = m; else hi = m;
  }
  vec3 P = uCam + rd*(Zof(lo) - uCam.z);
  vec2 uv = uvOf(P);
  vec3 c = texture(uImg, uv).rgb * uExpo;
  o = vec4(c, lo);
}`;

const COMP_FS = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D uA, uB;
uniform float uMix, uBlur, uWhip, uFlash, uTime, uGrain, uVig;
uniform vec2 uCenter, uRes;
vec3 zoomBlur(sampler2D t, vec2 uv, float k){
  if (k < 0.002) return texture(t, uv).rgb;
  vec3 a = vec3(0.0);
  for (int i = 0; i < 14; i++){ float s = 1.0 - k*float(i)/13.0; a += texture(t, uCenter + (uv - uCenter)*s).rgb; }
  return a/14.0;
}
vec3 whip(sampler2D t, vec2 uv, float k){
  vec3 a = vec3(0.0);
  for (int i = 0; i < 14; i++){ a += texture(t, uv + vec2(k*(float(i)/13.0 - 0.5), 0.0)).rgb; }
  return a/14.0;
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)))*43758.5453); }
void main(){
  vec3 a, b;
  if (uWhip > 0.001){ a = whip(uA, v, uWhip); b = whip(uB, v, uWhip); }
  else { a = zoomBlur(uA, v, uBlur); b = zoomBlur(uB, v, uBlur*0.6); }
  vec3 c = mix(a, b, uMix);
  c = mix(c, vec3(1.0, 0.97, 0.92), uFlash);
  vec2 q = v - 0.5;
  c *= 1.0 - uVig*dot(q, q)*1.6;
  c += (hash(v*uRes + fract(uTime)*91.0) - 0.5)*uGrain;
  o = vec4(c, 1.0);
}`;

function compile(gl, vs, fs){
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]){
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, "p"); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++){ const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
  return {p, u};
}
function loadImage(src){
  return new Promise((res, rej) => { const im = new Image(); im.decoding = "async"; im.onload = () => res(im); im.onerror = () => rej(new Error("could not load " + src)); im.src = src; });
}
function texFrom(gl, im, wrap){
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap === "mirror" ? gl.MIRRORED_REPEAT : wrap === "repeat" ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap === "mirror" ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE);
  gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}
function target(gl, w, h){
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  return {t, fb, w, h};
}

/* rotation matrix (column-major for uniformMatrix3fv) from yaw (right), pitch (up), roll */
function rotMat(yaw, pitch, roll){
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry(yaw) * Rx(-pitch) * Rz(roll); camera looks down +z, y up
  const Rz = [cr, sr, 0, -sr, cr, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];     // columns
  const Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const mul = (A, B) => { const C = new Array(9); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++){ let s = 0; for (let k = 0; k < 3; k++) s += A[k*3 + r]*B[c*3 + k]; C[c*3 + r] = s; } return C; };
  return new Float32Array(mul(Ry, mul(Rx, Rz)));
}

/* a point on the photo, given as percent across, percent down and disparity, in 3D */
function P3(u, v, d, asp){
  asp = asp || 1.6;
  const Z = 1/(NEAR + d*(1 - NEAR));
  const qx = (u/100*2 - 1)*asp, qy = 1 - v/100*2;
  return [qx*Z/F, qy*Z/F, Z];
}
/* yaw and pitch that aim a camera at pos toward the point tgt */
function aim(pos, tgt){
  const dx = tgt[0] - pos[0], dy = tgt[1] - pos[1], dz = tgt[2] - pos[2];
  return [Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz))];
}

function create(canvas, opts){
  opts = opts || {};
  const gl = canvas.getContext("webgl2", {antialias: false, alpha: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: "high-performance"});
  if (!gl) return null;
  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const scene = compile(gl, VS, SCENE_FS);
  const comp = compile(gl, VS, opts.compFS || COMP_FS);
  let A = null, B = null, W = 0, H = 0;
  const scenes = {};
  function size(){
    const maxPx = opts.maxPixels || 2.4e6;
    let dpr = Math.min(window.devicePixelRatio || 1, opts.maxDpr || 1.75);
    let w = Math.round(canvas.clientWidth*dpr), h = Math.round(canvas.clientHeight*dpr);
    const k = Math.min(1, Math.sqrt(maxPx/(w*h || 1)));
    w = Math.max(2, Math.round(w*k)); h = Math.max(2, Math.round(h*k));
    if (w === W && h === H) return;
    W = w; H = h; canvas.width = w; canvas.height = h;
    A = target(gl, w, h); B = target(gl, w, h);
  }
  async function add(name, img, depth){
    const [im, dp] = await Promise.all([loadImage(img), loadImage(depth)]);
    scenes[name] = {img: texFrom(gl, im), dep: texFrom(gl, dp), asp: im.naturalWidth/im.naturalHeight, im};
    return scenes[name];
  }
  const extra = {};
  async function addTex(name, url, wrap){ extra[name] = texFrom(gl, await loadImage(url), wrap); return extra[name]; }
  function drawScene(tgt, sc, cam){
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fb); gl.viewport(0, 0, tgt.w, tgt.h);
    gl.useProgram(scene.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sc.img); gl.uniform1i(scene.u.uImg, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sc.dep); gl.uniform1i(scene.u.uDep, 1);
    gl.uniform2f(scene.u.uRes, tgt.w, tgt.h);
    gl.uniform1f(scene.u.uAsp, sc.asp); gl.uniform1f(scene.u.uF, F); gl.uniform1f(scene.u.uNear, NEAR);
    gl.uniform1f(scene.u.uZoom, cam.zoom || 1);
    gl.uniform3f(scene.u.uCam, cam.pos[0], cam.pos[1], cam.pos[2]);
    gl.uniformMatrix3fv(scene.u.uRot, false, rotMat(cam.yaw || 0, cam.pitch || 0, cam.roll || 0));
    gl.uniform1f(scene.u.uExpo, cam.expo == null ? 1 : cam.expo);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  /* frame: {a:{scene, cam}, b:{scene, cam}|null, mix, blur, whip, flash, center:[x,y], time, extra uniforms} */
  function render(fr){
    size();
    drawScene(A, scenes[fr.a.scene], fr.a.cam);
    if (fr.b) drawScene(B, scenes[fr.b.scene], fr.b.cam);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.useProgram(comp.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, A.t); gl.uniform1i(comp.u.uA, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (fr.b ? B : A).t); gl.uniform1i(comp.u.uB, 1);
    const set1 = (n, x) => comp.u[n] && gl.uniform1f(comp.u[n], x);
    set1("uMix", fr.b ? (fr.mix || 0) : 0); set1("uBlur", fr.blur || 0); set1("uWhip", fr.whip || 0);
    set1("uFlash", fr.flash || 0); set1("uTime", fr.time || 0); set1("uGrain", fr.grain == null ? 0.035 : fr.grain); set1("uVig", fr.vig == null ? 0.35 : fr.vig);
    comp.u.uCenter && gl.uniform2f(comp.u.uCenter, (fr.center || [0.5, 0.5])[0], (fr.center || [0.5, 0.5])[1]);
    comp.u.uRes && gl.uniform2f(comp.u.uRes, W, H);
    if (fr.tex){ let unit = 2; for (const k in fr.tex){ if (!comp.u[k]) continue; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, extra[fr.tex[k]]); gl.uniform1i(comp.u[k], unit); unit++; } }
    if (fr.uniforms) for (const k in fr.uniforms){ const val = fr.uniforms[k]; if (!comp.u[k]) continue; if (typeof val === "number") gl.uniform1f(comp.u[k], val); else if (val.length === 2) gl.uniform2fv(comp.u[k], val); else if (val.length === 3) gl.uniform3fv(comp.u[k], val); else if (val.length === 4) gl.uniform4fv(comp.u[k], val); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  return {gl, add, addTex, render, scenes, size, get width(){ return W; }, get height(){ return H; }};
}

window.DepthCam = {create, P3, aim, NEAR, F, loadImage, compile, texFrom, VS};
})();
