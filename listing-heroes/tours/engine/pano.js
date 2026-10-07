/* pano.js: a small WebGL2 360 engine for listing pages.
 *
 * One full-screen shader renders up to two equirect panoramas (layers A and B) so rooms can blend.
 * Every pixel is a ray: origin = camera offset inside the unit sphere (+ a projection pull-back k),
 * direction = view basis * screen point. k = 0 is a normal lens, k = 1 is stereographic (little planet),
 * a camera offset toward a door makes the room stretch past you like you walked forward.
 *
 * Looks (uniform "look"): exposure, saturation, warmth, vignette, grain, sepia "develop" amount,
 * line-drawing amount and a light-reveal spot, plus a soft nadir cap over the tripod.
 */
(function (G) {
  'use strict';
  const VS = `#version 300 es
  in vec2 p; out vec2 vUv;
  void main(){ vUv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

  const FS = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 o;
  uniform sampler2D tA, tB;
  uniform vec2 res;
  uniform vec2 shift; // move the projection center (uv units), e.g. to sit a little planet beside a title
  uniform float aspect, tanH;
  // per layer: basis (right, up, fwd), camera offset, k, alpha, blur
  uniform mat3 bA, bB;
  uniform vec3 offA, offB;
  uniform float kA, kB, alphaB, blurA, blurB, rollA;
  uniform float flatA, flatB;    // 1 = flat photo (not equirect), drawn as a cover-fit plate
  uniform vec4 flatRA, flatRB;   // x,y,scale,aspect of the flat photo
  // look
  uniform float expo, sat, warm, vig, grain, time, develop, lineAmt, nadir;
  uniform vec3 tint; uniform float tintAmt;
  uniform vec3 spot; // x,y in screen uv, z radius (0 = off): inside the spot the photo shows, outside the line drawing
  uniform float spotSoft;

  const float PI = 3.14159265359;

  vec2 eq(vec3 d){
    d = normalize(d);
    float lon = atan(d.x, -d.z);
    float lat = asin(clamp(d.y,-1.,1.));
    return vec2(0.5 + lon/(2.*PI), 0.5 - lat/PI);
  }
  vec3 hit(vec3 O, vec3 D){
    float b = dot(O,D); float c = dot(O,O)-1.;
    float t = -b + sqrt(max(b*b - c, 0.));
    return O + t*D;
  }
  vec4 samp(sampler2D t, vec3 d, float lod){
    vec2 uv = eq(d);
    vec2 uv2 = vec2(fract(uv.x+0.5), uv.y);
    vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
    if (abs(dx2.x) < abs(dx.x)) dx.x = dx2.x;
    if (abs(dy2.x) < abs(dy.x)) dy.x = dy2.x;
    if (lod > 0.) return textureLod(t, uv, lod);
    return textureGrad(t, uv, dx, dy);
  }
  vec3 nadirCap(sampler2D t, vec3 d, vec3 col){
    if (nadir <= 0.) return col;
    float lat = asin(clamp(normalize(d).y,-1.,1.));
    float a = smoothstep(-1.12, -1.28, lat) * nadir; // ~ -64 to -73 deg
    if (a <= 0.) return col;
    vec3 ring = normalize(vec3(d.x, 0., d.z));
    vec3 r = ring*cos(-1.05) + vec3(0.,sin(-1.05),0.);
    vec3 floorc = samp(t, r, 5.5).rgb;
    vec3 center = textureLod(t, vec2(0.5, 0.97), 9.).rgb;
    float m = smoothstep(-1.25, -1.5, lat);
    return mix(col, mix(floorc, mix(floorc, center, .5), m), a);
  }
  vec3 layer(sampler2D t, mat3 B, vec3 off, float k, float blur, vec2 sp, float isFlat, vec4 fr){
    if (isFlat > .5){
      // cover-fit plate with a little zoom (fr.z) and pan (fr.xy)
      vec2 q = (vUv - .5);
      float sa = aspect / fr.w;
      vec2 uv = vec2(q.x * (sa > 1. ? 1. : sa), q.y * (sa > 1. ? 1./sa : 1.)) / fr.z + .5 + fr.xy;
      uv.y = 1. - uv.y;
      return texture(t, clamp(uv, 0., 1.)).rgb;
    }
    vec3 D = normalize(B * vec3(sp, 1.));
    vec3 O = off - B[2]*k;
    vec3 d = hit(O, D);
    vec3 c = samp(t, d, 0.).rgb;
    if (blur > 0.001){
      // radial rush: samples pulled toward the screen center
      vec3 acc = c; float w = 1.;
      for (int i=1;i<6;i++){
        float s = 1. - blur*float(i)/6.;
        vec3 Di = normalize(B * vec3(sp*s, 1.));
        acc += samp(t, hit(O, Di), 1.).rgb; w += 1.;
      }
      c = acc/w;
    }
    return nadirCap(t, d, c);
  }
  float luma(vec3 c){ return dot(c, vec3(.2126,.7152,.0722)); }
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }

  void main(){
    vec2 sp = ((vUv - shift)*2.-1.) * vec2(aspect,1.) * tanH;
    vec3 c = layer(tA, bA, offA, kA, blurA, sp, flatA, flatRA);
    if (alphaB > 0.001){
      vec3 cb = layer(tB, bB, offB, kB, blurB, sp, flatB, flatRB);
      c = mix(c, cb, alphaB);
    }
    // grade
    c *= expo;
    float L = luma(c);
    c = mix(vec3(L), c, sat);
    c *= vec3(1.+warm*.06, 1., 1.-warm*.08);
    if (tintAmt > 0.) c = mix(c, tint * (L*1.15), tintAmt);
    if (develop > 0.){
      // albumen print: sepia, crushed blacks lifted, highlights warm, soft
      vec3 sep = vec3(L*1.07+.04, L*.93+.03, L*.74+.02);
      sep = mix(sep, vec3(.95,.90,.80), .12);
      c = mix(c, sep, develop);
    }
    if (lineAmt > 0.){
      // reuse the gradient trick on the composed image of layer A
      float e = 1.25 / res.y * 2. * tanH;
      vec3 O = offA - bA[2]*kA; float l[9]; int n=0;
      for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
        vec3 D = normalize(bA * vec3(sp + vec2(float(i),float(j))*e, 1.));
        l[n++] = luma(samp(tA, hit(O,D), 0.4).rgb);
      }
      float gx = (l[2]+2.*l[5]+l[8]) - (l[0]+2.*l[3]+l[6]);
      float gy = (l[6]+2.*l[7]+l[8]) - (l[0]+2.*l[1]+l[2]);
      float g = smoothstep(.05, .28, sqrt(gx*gx+gy*gy));
      vec3 paper = vec3(.955,.95,.93);
      vec3 ink = vec3(.12,.16,.22);
      vec3 drawn = mix(paper, ink, g*.9);
      float m = lineAmt;
      if (spot.z > 0.){
        vec2 q = (vUv - spot.xy) * vec2(aspect, 1.);
        float r = length(q);
        m *= smoothstep(spot.z*(1.-spotSoft), spot.z, r);
      }
      c = mix(c, drawn, m);
    }
    float v = length((vUv-.5)*vec2(aspect,1.)*.9);
    c *= mix(1., smoothstep(1.15, .25, v), vig);
    c += (hash(vUv*res + time) - .5) * grain;
    o = vec4(c, 1.);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  const D2R = Math.PI / 180;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapPi = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
  const dirOf = (yaw, pitch) => [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];

  function basis(yaw, pitch, roll) {
    const f = dirOf(yaw, pitch);
    let r = [-f[2], 0, f[0]]; const rl = Math.hypot(r[0], r[2]) || 1e-6; r = [r[0] / rl, 0, r[2] / rl];
    let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      const r2 = r.map((v, i) => v * c + u[i] * s), u2 = u.map((v, i) => -r[i] * s + v * c); r = r2; u = u2;
    }
    return { r, u, f, m: new Float32Array([...r, ...u, ...f]) };
  }

  class Pano {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 not available');
      this.gl = gl;
      this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      const pr = gl.createProgram();
      gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      this.pr = pr; gl.useProgram(pr);
      const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.U = {};
      const n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(pr, i); this.U[a.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(pr, a.name); }
      gl.uniform1i(this.U.tA, 0); gl.uniform1i(this.U.tB, 1);
      this.cache = new Map();
      this.A = this.layer(); this.B = this.layer(); this.alphaB = 0;
      this.shift = [0, 0];
      this.fov = opts.fov || 80; this.dpr = Math.min(opts.dpr || window.devicePixelRatio || 1, opts.maxDpr || 2);
      this.look = Object.assign({ expo: 1, sat: 1, warm: 0, vig: .25, grain: .018, develop: 0, lineAmt: 0, nadir: 1, tint: [1, 1, 1], tintAmt: 0, spot: [0.5, 0.5, 0], spotSoft: .5 }, opts.look || {});
      this.t0 = performance.now();
      this.onframe = null;
      this.resize();
      addEventListener('resize', () => this.resize());
      this.loop = this.loop.bind(this); requestAnimationFrame(this.loop);
    }
    layer() { return { tex: null, yaw: 0, pitch: 0, roll: 0, k: 0, off: [0, 0, 0], blur: 0, flat: 0, flatR: [0, 0, 1, 1.5] }; }
    resize() {
      const c = this.canvas, w = c.clientWidth, h = c.clientHeight;
      c.width = Math.max(2, Math.round(w * this.dpr)); c.height = Math.max(2, Math.round(h * this.dpr));
      this.gl.viewport(0, 0, c.width, c.height);
    }
    /* load(url) -> texture handle {tex, w, h, flat}; smUrl paints first, full res swaps in */
    load(url, smUrl) {
      if (this.cache.has(url)) return this.cache.get(url);
      const gl = this.gl;
      const h = { tex: gl.createTexture(), ready: false, full: false, w: 0, h: 0, flat: false, url };
      const put = (img, full) => {
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, h.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
        h.w = img.naturalWidth || img.width; h.h = img.naturalHeight || img.height;
        h.flat = h.w / h.h < 1.9; h.ready = true; if (full) h.full = true;
      };
      const get = u => new Promise((res, rej) => { const i = new Image(); i.decoding = 'async'; i.onload = () => res(i); i.onerror = rej; i.src = u; });
      h.promise = (smUrl ? get(smUrl).then(i => { if (!h.full) put(i, false); }) : Promise.resolve())
        .then(() => h);
      h.fullPromise = get(url).then(i => (i.decode ? i.decode().catch(() => {}) : 0).then(() => { put(i, true); return h; }));
      if (!smUrl) h.promise = h.fullPromise;
      this.cache.set(url, h);
      return h;
    }
    set(L, h) {
      L.tex = h; L.flat = h && h.flat ? 1 : 0;
      if (h && h.flat) L.flatR[3] = h.w / h.h;
    }
    viewDir() { return dirOf(this.A.yaw, this.A.pitch); }
    /* screen position of a pano direction (yaw,pitch) for layer L in px; null if behind */
    project(yaw, pitch, L = this.A) {
      const b = basis(L.yaw, L.pitch, L.roll), d = dirOf(yaw, pitch);
      const z = d[0] * b.f[0] + d[1] * b.f[1] + d[2] * b.f[2]; if (z <= 0.05) return null;
      const x = (d[0] * b.r[0] + d[1] * b.r[1] + d[2] * b.r[2]) / z, y = (d[0] * b.u[0] + d[1] * b.u[1] + d[2] * b.u[2]) / z;
      const th = Math.tan(this.fov * D2R / 2), w = this.canvas.clientWidth, hh = this.canvas.clientHeight, asp = w / hh;
      return { x: (x / (asp * th) * .5 + .5) * w, y: (1 - (y / th * .5 + .5)) * hh, z };
    }
    /* yaw,pitch under a screen point (px) for layer A, rectilinear */
    pick(px, py) {
      const L = this.A, b = basis(L.yaw, L.pitch, L.roll), w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      const th = Math.tan(this.fov * D2R / 2), sx = (px / w * 2 - 1) * (w / h) * th, sy = (1 - py / h * 2) * th;
      const d = [b.r[0] * sx + b.u[0] * sy + b.f[0], b.r[1] * sx + b.u[1] * sy + b.f[1], b.r[2] * sx + b.u[2] * sy + b.f[2]];
      const l = Math.hypot(...d);
      return { yaw: Math.atan2(d[0], -d[2]), pitch: Math.asin(d[1] / l) };
    }
    draw() {
      const gl = this.gl, U = this.U, A = this.A, B = this.B, lk = this.look;
      const w = this.canvas.width, h = this.canvas.height;
      gl.uniform2f(U.res, w, h); gl.uniform1f(U.aspect, w / h);
      gl.uniform2f(U.shift, this.shift[0], this.shift[1]);
      gl.uniform1f(U.tanH, Math.tan(this.fov * D2R / 2));
      const bind = (L, unit, U_b, U_off, U_k, U_blur, U_flat, U_fr) => {
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, L.tex && L.tex.ready ? L.tex.tex : null);
        gl.uniformMatrix3fv(U_b, false, basis(L.yaw, L.pitch, L.roll).m);
        gl.uniform3fv(U_off, L.off); gl.uniform1f(U_k, L.k); gl.uniform1f(U_blur, L.blur);
        gl.uniform1f(U_flat, L.flat); gl.uniform4fv(U_fr, L.flatR);
      };
      bind(A, 0, U.bA, U.offA, U.kA, U.blurA, U.flatA, U.flatRA);
      bind(B, 1, U.bB, U.offB, U.kB, U.blurB, U.flatB, U.flatRB);
      gl.uniform1f(U.alphaB, B.tex && B.tex.ready ? this.alphaB : 0);
      gl.uniform1f(U.expo, lk.expo); gl.uniform1f(U.sat, lk.sat); gl.uniform1f(U.warm, lk.warm);
      gl.uniform1f(U.vig, lk.vig); gl.uniform1f(U.grain, lk.grain); gl.uniform1f(U.develop, lk.develop);
      gl.uniform1f(U.lineAmt, lk.lineAmt); gl.uniform1f(U.nadir, lk.nadir);
      gl.uniform3fv(U.tint, lk.tint); gl.uniform1f(U.tintAmt, lk.tintAmt);
      gl.uniform3fv(U.spot, lk.spot); gl.uniform1f(U.spotSoft, lk.spotSoft);
      gl.uniform1f(U.time, (performance.now() - this.t0) / 1000 % 100);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    loop(t) {
      if (this.onframe) this.onframe(t);
      if (this.A.tex && this.A.tex.ready) this.draw();
      requestAnimationFrame(this.loop);
    }
  }

  /* Tour: a graph of rooms with solved headings. walk() moves through a door like a dolly shot. */
  class Tour {
    constructor(pano, layout, base, opts = {}) {
      this.p = pano; this.L = layout; this.base = base; this.opts = opts;
      this.rooms = new Map(layout.rooms.map(r => [r.i, r]));
      this.cur = null; this.busy = false;
      this.dragging = false; this.vel = 0; this.vy = 0; this.auto = opts.auto ?? 0.02;
    }
    url(i, sm) { return `${this.base}/${String(i).padStart(2, '0')}${sm ? '-sm' : ''}.jpg`; }
    tex(i) { return this.p.load(this.url(i), this.url(i, true)); }
    async show(i, yaw = 0, pitch = 0) {
      const h = this.tex(i); await h.promise; this.p.set(this.p.A, h);
      Object.assign(this.p.A, { yaw, pitch, k: 0, off: [0, 0, 0], blur: 0 }); this.p.alphaB = 0;
      this.cur = this.rooms.get(i); this.prefetch(i); return this.cur;
    }
    prefetch(i) { const r = this.rooms.get(i); if (!r) return; for (const l of r.links) this.tex(l.to); }
    link(from, to) { const r = this.rooms.get(from); return r && r.links.find(l => l.to === to); }
    /* heading-consistent yaw in room b for a world direction seen as yaw y in room a */
    carry(a, b, y) {
      const ra = this.rooms.get(a), rb = this.rooms.get(b);
      if (!ra || !rb || ra.comp !== rb.comp) return null;
      return wrapPi(ra.heading + y - rb.heading);
    }
    /* walk to room j. dur seconds. Returns a promise. */
    async walk(j, opts = {}) {
      if (this.busy || !this.cur || j === this.cur.i) return;
      this.busy = true;
      const p = this.p, A = p.A, B = p.B, i = this.cur.i;
      const lk = this.link(i, j);
      const hB = this.tex(j); await hB.promise;
      const doorYaw = lk ? lk.yaw : A.yaw;
      let doorPitch = lk ? clamp(lk.pitch, -0.35, 0.25) : 0;
      // 1) turn toward the door
      const y0 = A.yaw, p0 = A.pitch, dy = wrapPi(doorYaw - y0), turnPitch = clamp(doorPitch * .5, -.2, .15);
      const pace = this.opts.pace || 1, rush = this.opts.blur ?? 1;
      const turnT = (opts.turn ?? clamp(Math.abs(dy) / 2.4, .25, .9)) * pace;
      await this.tween(turnT, t => { const e = ease(t); A.yaw = y0 + dy * e; A.pitch = lerp(p0, turnPitch, e); });
      // 2) dolly through
      const arrive = this.carry(i, j, doorYaw);
      p.set(B, hB);
      const by = arrive ?? 0;
      Object.assign(B, { yaw: by, pitch: A.pitch, roll: 0, k: 0, blur: 0 });
      const fwdA = dirOf(doorYaw, 0), fwdB = dirOf(by, 0), D = opts.dist ?? this.opts.dist ?? .82, fov0 = p.fov;
      const dur = (opts.dur ?? 1.15) * pace, pulse = this.opts.pulse ?? 6;
      await this.tween(dur, t => {
        const e = ease(t);
        A.off = fwdA.map(v => v * D * easeOut(Math.min(1, t * 1.15)));
        B.off = fwdB.map(v => -v * D * (1 - e));
        A.blur = Math.sin(Math.PI * t) * .10 * rush; B.blur = Math.sin(Math.PI * t) * .08 * rush;
        p.alphaB = clamp((t - .28) / .5, 0, 1); p.alphaB = p.alphaB * p.alphaB * (3 - 2 * p.alphaB);
        p.fov = fov0 + Math.sin(Math.PI * t) * pulse;
        B.pitch = lerp(A.pitch, 0, e) ; B.yaw = by;
      });
      // swap
      p.set(A, hB); Object.assign(A, { yaw: by, pitch: B.pitch, off: [0, 0, 0], blur: 0, k: 0 });
      p.alphaB = 0; p.fov = fov0; Object.assign(B, { off: [0, 0, 0], blur: 0 });
      this.cur = this.rooms.get(j); this.prefetch(j);
      this.busy = false;
      if (this.onroom) this.onroom(this.cur);
    }
    /* crossfade to a room that has no door link (or another component) */
    async cut(j, yaw = 0, dur = .9) {
      if (this.busy) return; this.busy = true;
      const p = this.p, A = p.A, B = p.B, hB = this.tex(j); await hB.promise;
      p.set(B, hB); Object.assign(B, { yaw, pitch: 0, k: 0, off: [0, 0, 0] });
      const fov0 = p.fov;
      await this.tween(dur, t => {
        const e = ease(t); p.alphaB = e; A.off = dirOf(A.yaw, 0).map(v => v * .35 * e);
        B.off = dirOf(yaw, 0).map(v => -v * .3 * (1 - e)); p.fov = fov0 + Math.sin(Math.PI * t) * 4;
      });
      p.set(A, hB); Object.assign(A, { yaw, pitch: 0, off: [0, 0, 0] }); p.alphaB = 0; p.fov = fov0;
      this.cur = this.rooms.get(j); this.prefetch(j); this.busy = false;
      if (this.onroom) this.onroom(this.cur);
    }
    tween(sec, f) {
      return new Promise(res => {
        const t0 = performance.now();
        const step = now => { const t = Math.min(1, (now - t0) / (sec * 1000)); f(t); t < 1 ? requestAnimationFrame(step) : res(); };
        requestAnimationFrame(step);
      });
    }
    /* drag to look, wheel/pinch zoom */
    attach(el) {
      const p = this.p; let lx = 0, ly = 0, id = null, moved = 0;
      el.addEventListener('pointerdown', e => { id = e.pointerId; lx = e.clientX; ly = e.clientY; moved = 0; this.dragging = true; el.setPointerCapture(id); this.vel = 0; this.vy = 0; });
      el.addEventListener('pointermove', e => {
        if (e.pointerId !== id) return;
        const s = p.fov * D2R / el.clientHeight; const dx = e.clientX - lx, dy = e.clientY - ly;
        moved += Math.abs(dx) + Math.abs(dy);
        if (!this.busy) { p.A.yaw -= dx * s; p.A.pitch = clamp(p.A.pitch + dy * s, -1.3, 1.3); }
        this.vel = -dx * s; this.vy = dy * s; lx = e.clientX; ly = e.clientY;
      });
      const up = e => { if (e.pointerId !== id) return; id = null; this.dragging = false; this.lastMoved = moved; };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      el.addEventListener('wheel', e => { if (this.opts.wheelZoom === false) return; e.preventDefault(); p.fov = clamp(p.fov + e.deltaY * .04, 35, 100); }, { passive: false });
    }
    idle(dt) {
      const A = this.p.A;
      if (this.busy || this.dragging) return;
      A.yaw += this.vel; A.pitch = clamp(A.pitch + this.vy, -1.3, 1.3);
      this.vel *= .92; this.vy *= .9;
      if (Math.abs(this.vel) < 1e-4) A.yaw += this.auto * dt;
    }
  }

  G.PanoKit = { Pano, Tour, basis, dirOf, wrapPi, clamp, ease, easeOut, lerp, D2R };
})(window);
