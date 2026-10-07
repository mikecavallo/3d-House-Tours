/* SiteSound: a synthesized construction-site soundscape for the scroll build.
   Everything is generated live with Web Audio (no audio files). Sounds are tied to the build STAGE, not to scroll
   speed: each stage runs its own scheduler at a natural pace and keeps playing while the visitor pauses.
   API:  SiteSound.toggle() -> bool    turn on/off (must be called from a click/tap; browsers block autoplay)
         SiteSound.update(stage)        "site" | "concrete" | "framing" | "roofing" | "exterior" | "landscape" | "finished"
         SiteSound.setLevel(0..1)       fades everything (e.g. as the build scrolls out of view)
         SiteSound.cue("mallet", delaySec)   three mallet blows on the sign post
         SiteSound.isOn()
         SiteSound.engine(ctx, dest)    the voice library on any AudioContext (used for offline checks) */
(function(){
"use strict";

const rand = (a, b) => a + Math.random()*(b - a);
const pickOne = a => a[(Math.random()*a.length) | 0];

function makeEngine(ctx, dest){
  const sr = ctx.sampleRate;
  /* ---- noise buffers ---- */
  function buffer(seconds, fill){
    const b = ctx.createBuffer(2, Math.floor(sr*seconds), sr);
    for (let c = 0; c < 2; c++) fill(b.getChannelData(c));
    return b;
  }
  const white = buffer(3, d => { for (let i = 0; i < d.length; i++) d[i] = Math.random()*2 - 1; });
  const pink = buffer(4, d => {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++){
      const w = Math.random()*2 - 1;
      b0 = 0.99886*b0 + w*0.0555179; b1 = 0.99332*b1 + w*0.0750759; b2 = 0.96900*b2 + w*0.1538520;
      b3 = 0.86650*b3 + w*0.3104856; b4 = 0.55000*b4 + w*0.5329522; b5 = -0.7616*b5 - w*0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w*0.5362)*0.11; b6 = w*0.115926;
    }
  });
  const brown = buffer(4, d => { let l = 0; for (let i = 0; i < d.length; i++){ l = (l + 0.02*(Math.random()*2 - 1))/1.02; d[i] = l*3.5; } });

  /* ---- outdoor space: short diffuse reverb with an early slap off the house ---- */
  const verb = ctx.createConvolver();
  verb.buffer = buffer(1.6, d => {
    for (let i = 0; i < d.length; i++){
      const t = i/sr;
      d[i] = (Math.random()*2 - 1)*Math.pow(1 - t/1.6, 3.2)*(t < 0.004 ? 0 : 1);
    }
    const slap = Math.floor(0.045*sr);
    for (let i = 0; i < 300; i++) d[slap + i] += (Math.random()*2 - 1)*0.6*(1 - i/300);
  });
  const verbOut = ctx.createGain(); verbOut.gain.value = 0.55;
  verb.connect(verbOut); verbOut.connect(dest);

  /* a voice output: distance gain, stereo position, reverb send */
  function out(pan, level, wet){
    const g = ctx.createGain(); g.gain.value = level;
    let tail = g;
    if (ctx.createStereoPanner){ const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); tail = p; }
    tail.connect(dest);
    if (wet){ const s = ctx.createGain(); s.gain.value = wet; tail.connect(s); s.connect(verb); }
    return g;
  }
  function noiseSrc(buf, t, dur, rate){
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
    if (rate) s.playbackRate.value = rate;
    s.start(t, Math.random()*(buf.duration - 0.5)); s.stop(t + dur + 0.05);
    return s;
  }
  function filt(type, freq, q){ const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q != null) f.Q.value = q; return f; }
  /* attack/decay envelope on a fresh gain node */
  function env(t, attack, peak, decay){
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + Math.max(attack, 0.0005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }
  function chain(...nodes){ for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }
  function osc(type, f, t, dur){ const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(t + dur + 0.05); return o; }

  const V = {};

  /* ---- hammer on a nail: steel click, short nail ring, wood body thump ---- */
  V.hammerHit = (t, o, s, ring) => {
    s = s == null ? 1 : s;
    chain(noiseSrc(white, t, 0.03), filt("highpass", 2600), env(t, 0.0008, 0.55*s, 0.014), o);
    [2280, 3390, 4720].forEach((f, i) => chain(osc("sine", f*ring, t, 0.2), env(t, 0.0008, [0.09, 0.05, 0.025][i]*s, 0.05 + 0.04*(2 - i)), o));
    const th = osc("sine", 160, t, 0.2); th.frequency.exponentialRampToValueAtTime(68, t + 0.09);
    chain(th, env(t, 0.002, 0.75*s, 0.1), o);
    chain(noiseSrc(white, t, 0.12), filt("bandpass", 430, 2.5), env(t, 0.001, 0.9*s, 0.075), o);
  };
  /* drive one nail: 3-5 blows, the nail rings a little higher as it seats, last blow sets it */
  V.hammerDrive = (t) => {
    const o = out(rand(-0.75, 0.75), rand(0.22, 0.55), rand(0.25, 0.45));
    const n = 3 + ((Math.random()*3) | 0), gap = rand(0.3, 0.42), ring = rand(0.9, 1.12);
    for (let i = 0; i < n; i++){
      const last = i === n - 1;
      V.hammerHit(t + i*gap + rand(-0.02, 0.02), o, last ? 1.15 : rand(0.6, 0.9), ring*(1 + i*0.03));
    }
    return n*gap + 0.3;
  };

  /* ---- circular saw: motor spins up, bogs down while it bites the board, spins down ---- */
  V.saw = (t) => {
    const cut = rand(1.0, 2.2), up = 0.35, end = t + up + 0.25 + cut + 0.15, total = end - t + 1.0;
    const o = out(rand(-0.6, 0.6), rand(0.55, 0.95), 0.3);
    const motor = ctx.createGain(); motor.gain.setValueAtTime(0.0001, t);
    motor.gain.exponentialRampToValueAtTime(0.11, t + up);
    motor.gain.setValueAtTime(0.11, t + up + 0.25);
    motor.gain.linearRampToValueAtTime(0.16, t + up + 0.4);
    motor.gain.setValueAtTime(0.16, end - 0.1);
    motor.gain.linearRampToValueAtTime(0.1, end);
    motor.gain.exponentialRampToValueAtTime(0.0001, end + 0.95);
    const shaper = ctx.createWaveShaper(), curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++){ const x = i/511.5 - 1; curve[i] = Math.tanh(2.2*x); }
    shaper.curve = curve;
    const lp = filt("lowpass", 3200, 0.8);
    [[1, "sawtooth", 0.6], [2, "square", 0.25], [3.02, "sawtooth", 0.15]].forEach(([mult, type, lvl]) => {
      const m = ctx.createOscillator(); m.type = type;
      const f = m.frequency;
      f.setValueAtTime(30*mult, t); f.exponentialRampToValueAtTime(205*mult, t + up);
      f.setValueAtTime(205*mult, t + up + 0.25); f.exponentialRampToValueAtTime(168*mult, t + up + 0.45);
      f.setValueAtTime(168*mult, end - 0.12); f.exponentialRampToValueAtTime(210*mult, end + 0.05);
      f.exponentialRampToValueAtTime(25*mult, end + 0.95);
      const g = ctx.createGain(); g.gain.value = lvl;
      m.connect(g); g.connect(shaper); m.start(t); m.stop(t + total);
    });
    chain(shaper, lp, motor, o);
    /* blade tearing through wood: bright noise that swells and jitters during the cut */
    const bite = ctx.createGain(); bite.gain.setValueAtTime(0.0001, t);
    bite.gain.setValueAtTime(0.0001, t + up + 0.25);
    bite.gain.exponentialRampToValueAtTime(0.32, t + up + 0.4);
    for (let k = t + up + 0.45; k < end - 0.1; k += 0.11) bite.gain.linearRampToValueAtTime(rand(0.2, 0.36), k);
    bite.gain.exponentialRampToValueAtTime(0.0001, end + 0.08);
    chain(noiseSrc(white, t, total), filt("bandpass", 3600, 1.1), bite, o);
    chain(noiseSrc(pink, t, total), filt("bandpass", 900, 1.4), env(t + up + 0.3, 0.1, 0.12, cut), o);
    /* the offcut drops */
    chain(noiseSrc(white, end, 0.2), filt("bandpass", 700, 3), env(end + 0.05, 0.001, 0.4, 0.08), o);
    return total;
  };

  /* ---- pneumatic nail gun: air pop, driver thump, exhaust hiss ---- */
  V.nailShot = (t, o, s) => {
    s = s == null ? 1 : s;
    chain(noiseSrc(white, t, 0.08), filt("bandpass", 1500, 0.9), env(t, 0.0008, 0.7*s, 0.035), o);
    const th = osc("sine", 120, t, 0.12); th.frequency.exponentialRampToValueAtTime(55, t + 0.06);
    chain(th, env(t, 0.001, 0.9*s, 0.06), o);
    chain(noiseSrc(white, t, 0.02), filt("highpass", 3500), env(t, 0.0004, 0.5*s, 0.006), o);
    chain(noiseSrc(white, t + 0.02, 0.25), filt("highpass", 5200), env(t + 0.025, 0.012, 0.09*s, 0.16), o);
  };
  V.nailBurst = (t, n, gap) => {
    const o = out(rand(-0.7, 0.7), rand(0.3, 0.65), 0.35);
    n = n || (2 + ((Math.random()*4) | 0)); gap = gap || rand(0.28, 0.55);
    for (let i = 0; i < n; i++) V.nailShot(t + i*gap + rand(-0.03, 0.03), o, rand(0.75, 1));
    return n*gap + 0.3;
  };
  /* roofers bump-fire: quick runs along a shingle course */
  V.roofRun = (t) => V.nailBurst(t, 4 + ((Math.random()*5) | 0), rand(0.16, 0.22));

  /* ---- shovel in gravel and soil ---- */
  V.shovel = (t) => {
    const o = out(rand(-0.6, 0.6), rand(0.14, 0.3), 0.25);
    chain(noiseSrc(white, t, 0.6), filt("bandpass", 2300, 1.4), env(t, 0.06, 0.22, 0.32), o);
    for (let i = 0; i < 10; i++) chain(noiseSrc(white, t, 0.5), filt("bandpass", rand(2800, 5200), 4), env(t + rand(0.05, 0.4), 0.0005, rand(0.15, 0.35), 0.012), o);
    chain(noiseSrc(brown, t + 0.55, 0.4), filt("lowpass", 500), env(t + 0.55, 0.01, 0.6, 0.18), o);   /* the load lands */
    return 1.1;
  };
  /* ---- concrete sliding down the chute ---- */
  V.pour = (t) => {
    const d = rand(2.5, 4.5), o = out(rand(-0.4, 0.4), 1.2, 0.3);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.6);
    for (let k = t + 0.7; k < t + d; k += 0.25) g.gain.linearRampToValueAtTime(rand(0.3, 0.55), k);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.8);
    const bp = filt("bandpass", 420, 0.9);
    bp.frequency.setValueAtTime(380, t); bp.frequency.linearRampToValueAtTime(560, t + d);
    chain(noiseSrc(pink, t, d + 1), bp, g, o);
    return d + 1;
  };

  /* ---- birds: chickadee, robin, cardinal, song sparrow ---- */
  function note(t, o, f0, f1, dur, level, vib){
    const s = ctx.createOscillator(); s.type = "sine";
    s.frequency.setValueAtTime(f0, t); s.frequency.exponentialRampToValueAtTime(f1, t + dur);
    if (vib){
      const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = vib[0]; lg.gain.value = vib[1];
      l.connect(lg); lg.connect(s.frequency); l.start(t); l.stop(t + dur + 0.05);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + Math.min(0.02, dur*0.3));
    g.gain.setValueAtTime(level, t + dur*0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(g); g.connect(o); s.start(t); s.stop(t + dur + 0.05);
  }
  V.bird = (t) => {
    const o = out(rand(-0.9, 0.9), rand(0.08, 0.22), 0.5), k = Math.random();
    let d = 0;
    if (k < 0.25){            /* chickadee "fee-bee" */
      const f = rand(3600, 4100);
      note(t, o, f, f*0.985, 0.32, 0.5); note(t + 0.38, o, f*0.86, f*0.85, 0.36, 0.45); d = 0.8;
    } else if (k < 0.55){     /* robin: rich rising and falling carols */
      const n = 4 + ((Math.random()*4) | 0);
      for (let i = 0; i < n; i++){ const a = rand(2100, 3300); note(t + d, o, a, a*rand(0.8, 1.25), rand(0.11, 0.2), rand(0.35, 0.55), [rand(35, 60), rand(40, 110)]); d += rand(0.18, 0.3); }
    } else if (k < 0.8){      /* cardinal "cheer cheer cheer" */
      const n = 3 + ((Math.random()*3) | 0);
      for (let i = 0; i < n; i++){ note(t + d, o, rand(3700, 4200), rand(1700, 2000), 0.17, 0.5); d += 0.27; }
    } else {                  /* song sparrow: a few notes then a buzzy trill */
      note(t, o, 3000, 3100, 0.12, 0.4); note(t + 0.18, o, 3000, 3100, 0.12, 0.4); note(t + 0.36, o, 2600, 2700, 0.1, 0.35);
      for (let i = 0; i < 10; i++) note(t + 0.55 + i*0.045, o, 5200, 4300, 0.04, 0.3);
      note(t + 1.05, o, 4200, 2600, 0.2, 0.35, [45, 150]); d = 1.3;
    }
    return d + 0.2;
  };

  /* ---- rubber mallet driving the sign post ---- */
  V.mallet = (t, s) => {
    s = s == null ? 1 : s;
    const o = out(0.25, 0.85, 0.3);
    const th = osc("sine", 110, t, 0.3); th.frequency.exponentialRampToValueAtTime(52, t + 0.16);
    chain(th, env(t, 0.002, 0.95*s, 0.2), o);
    chain(noiseSrc(white, t, 0.2), filt("bandpass", 640, 4), env(t, 0.001, 0.9*s, 0.11), o);
    chain(noiseSrc(white, t, 0.05), filt("lowpass", 1600), env(t, 0.001, 0.5*s, 0.025), o);
    /* the hanging panel's hooks rattle after each blow */
    for (let i = 0; i < 3; i++) chain(osc("sine", rand(5200, 7400), t + 0.03 + i*0.05, 0.06), env(t + 0.03 + i*0.05, 0.001, 0.03*s, 0.05), o);
  };

  /* ---- continuous beds ---- */
  V.beds = (busOut) => {
    const b = {};
    const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
    const lfo = (rate, depth, param) => { const l = ctx.createOscillator(), g = ctx.createGain(); l.frequency.value = rate; g.gain.value = depth; l.connect(g); g.connect(param); l.start(); };
    /* ambient: low country air with slow gusts */
    b.ambient = ctx.createGain(); b.ambient.gain.value = 0;
    const amb = ctx.createGain(); amb.gain.value = 0.16; lfo(0.05, 0.06, amb.gain);
    chain(loop(brown), filt("lowpass", 420), amb, b.ambient, busOut);
    /* breeze through leaves: two moving bands of pink noise */
    b.breeze = ctx.createGain(); b.breeze.gain.value = 0;
    const l1 = ctx.createGain(); l1.gain.value = 0.07; lfo(0.11, 0.05, l1.gain);
    const f1 = filt("bandpass", 900, 0.6); lfo(0.07, 350, f1.frequency);
    chain(loop(pink), f1, l1, b.breeze);
    const l2 = ctx.createGain(); l2.gain.value = 0.035; lfo(0.17, 0.028, l2.gain);
    chain(loop(white), filt("highpass", 3800), filt("lowpass", 9000), l2, b.breeze);
    b.breeze.connect(busOut);
    /* cement mixer: drum rumble with rotation pulse, diesel idle underneath */
    b.mixer = ctx.createGain(); b.mixer.gain.value = 0;
    const drum = ctx.createGain(); drum.gain.value = 0.32; lfo(0.45, 0.14, drum.gain);
    chain(loop(brown), filt("lowpass", 220), drum, b.mixer);
    const eng = ctx.createOscillator(); eng.type = "sawtooth"; eng.frequency.value = 46; eng.start();
    const engG = ctx.createGain(); engG.gain.value = 0.05; lfo(7.5, 0.012, engG.gain);
    chain(eng, filt("lowpass", 240), engG, b.mixer);
    const slosh = ctx.createGain(); slosh.gain.value = 0.06; lfo(0.45, 0.05, slosh.gain);
    chain(loop(pink), filt("bandpass", 520, 1.2), slosh, b.mixer);
    b.mixer.connect(busOut);
    return b;
  };
  return V;
}

/* ---------- live engine and stage scheduler ---------- */
const STAGES = {
  site:      {beds:{ambient:1, breeze:0.35, mixer:0}, birds:0, events:{}},
  concrete:  {beds:{ambient:1, breeze:0.15, mixer:1}, birds:0, events:{shovel:[2.2, 5], pour:[6, 10]}},
  framing:   {beds:{ambient:1, breeze:0.1, mixer:0}, birds:0, events:{hammerDrive:[0.9, 2.4], nailBurst:[2.5, 5.5]}},
  roofing:   {beds:{ambient:1, breeze:0.15, mixer:0}, birds:0, events:{roofRun:[1.4, 3.2], hammerDrive:[3, 7]}},
  exterior:  {beds:{ambient:1, breeze:0.2, mixer:0}, birds:0, events:{nailBurst:[1.8, 4], hammerDrive:[3.5, 8]}},
  landscape: {beds:{ambient:1, breeze:0.45, mixer:0}, birds:0, events:{shovel:[1.8, 4]}},
  finished:  {beds:{ambient:0.55, breeze:1, mixer:0}, birds:0, events:{}}
};
/* recorded layers (supplied by the listing agent): birds before and after the build, real construction during it.
   Played as long, randomly chosen, crossfaded chunks so neither file ever audibly loops. If they fail to load,
   the synthesized soundscape above takes over. */
const REC = {
  birds:        {url: "audio/birds.mp3",        gain: 1.0, seg: [18, 30], xf: 2.0},
  construction: {url: "audio/construction.mp3", gain: 0.95, seg: [10, 18], xf: 1.4}
};
const REC_MIX = {
  site: {birds: 1, construction: 0}, finished: {birds: 1, construction: 0},
  concrete: {birds: 0.1, construction: 1}, framing: {birds: 0.08, construction: 1}, roofing: {birds: 0.08, construction: 1},
  exterior: {birds: 0.1, construction: 1}, landscape: {birds: 0.3, construction: 0.75}
};
let rec = null, recState = "idle", hushed = false;
function loadRec(){
  recState = "loading";
  const decode = ab => new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej));
  Promise.all(Object.keys(REC).map(k => fetch(REC[k].url)
    .then(r => { if (!r.ok) throw new Error(REC[k].url + " " + r.status); return r.arrayBuffer(); })
    .then(decode).then(buf => [k, buf])))
    .then(list => {
      rec = {};
      list.forEach(([k, buf]) => {
        const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(master);
        rec[k] = {buf, bus, next: 0};
      });
      recState = "ready"; applyStage();
    })
    .catch(err => { console.warn("recorded sound unavailable, using synthesized", err); recState = "failed"; applyStage(); });
}
/* keep each recorded layer running: overlapping chunks from random points in the file, faded in and out */
function feedRec(now){
  Object.keys(rec).forEach(k => {
    const r = rec[k], cfg = REC[k], dur = r.buf.duration;
    if (r.next > now + 0.6) return;
    const t = Math.max(r.next, now + 0.03), seg = Math.min(rand(cfg.seg[0], cfg.seg[1]), dur - 1), xf = cfg.xf;
    const off = rand(0.3, Math.max(0.31, dur - seg - 0.1));
    const src = ctx.createBufferSource(); src.buffer = r.buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + xf);
    g.gain.setValueAtTime(1, t + seg - xf); g.gain.linearRampToValueAtTime(0, t + seg);
    src.connect(g); g.connect(r.bus);
    src.start(t, off, seg + 0.05);
    r.next = t + seg - xf;
  });
}

let ctx = null, master = null, voices = null, beds = null, on = false, stage = "site", level = 1, timer = null;
const nextAt = {};

function schedule(){
  if (!ctx || !on) return;
  const now = ctx.currentTime, st = STAGES[stage] || STAGES.site;
  if (recState === "ready"){ feedRec(now); return; }
  if (recState === "loading") return;
  const ev = Object.assign({}, st.events);
  if (st.birds > 0) ev.bird = [2.2/st.birds, 6/st.birds];
  Object.keys(ev).forEach(k => {
    if (nextAt[k] == null) nextAt[k] = now + rand(0.15, Math.min(2, ev[k][0]));
    if (nextAt[k] <= now + 0.2){
      const t = Math.max(nextAt[k], now + 0.02);
      const dur = voices[k](t) || 0;
      nextAt[k] = t + rand(ev[k][0], ev[k][1]) + (k === "saw" || k === "pour" ? dur*0.5 : 0);
    }
  });
}
function applyStage(){
  if (!beds) return;
  const st = STAGES[stage] || STAGES.site, now = ctx.currentTime, useRec = recState === "ready";
  Object.keys(beds).forEach(k => beds[k].gain.setTargetAtTime(useRec || recState === "loading" ? 0 : (st.beds[k] || 0), now, 0.7));
  if (useRec){
    const mix = REC_MIX[stage] || REC_MIX.site;
    Object.keys(rec).forEach(k => rec[k].bus.gain.setTargetAtTime((mix[k] || 0)*REC[k].gain, now, 0.9));
  }
  Object.keys(nextAt).forEach(k => { if (!(k in st.events) && k !== "bird") delete nextAt[k]; });
}
function applyLevel(){
  if (!master) return;
  master.gain.setTargetAtTime(on && !hushed ? 0.9*level : 0, ctx.currentTime, on && !hushed ? 0.35 : 0.6);
}
function start(){
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  if (!ctx){
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.25;
    master.connect(comp); comp.connect(ctx.destination);
    voices = makeEngine(ctx, master);
    beds = voices.beds(master);
    loadRec();
    document.addEventListener("visibilitychange", () => {
      if (!ctx) return;
      if (document.hidden) ctx.suspend(); else if (on) ctx.resume();
    });
  }
  if (ctx.state === "suspended") ctx.resume();
  return true;
}

const SiteSound = window.SiteSound = {
  isOn: () => on,
  toggle(){
    if (!on){
      if (!start()) return false;
      on = true; applyStage(); applyLevel();
      clearInterval(timer); timer = setInterval(schedule, 100);
    } else {
      on = false; applyLevel();
      clearInterval(timer); timer = null;
      setTimeout(() => { if (!on && ctx) ctx.suspend(); }, 600);
    }
    return on;
  },
  update(s){
    if (s === stage || !STAGES[s]) return;
    stage = s;
    if (on) applyStage();
  },
  /* fade out (the visitor chose to read the listing details); normal level returns once they reach the details */
  hush(){ hushed = true; applyLevel(); },
  setLevel(v){
    v = Math.max(0, Math.min(1, v));
    if (hushed && v < 0.1){ hushed = false; }
    if (Math.abs(v - level) < 0.02) return;
    level = v; applyLevel();
  },
  cue(name, delay){
    if (!on || !ctx) return;
    const t = ctx.currentTime + (delay || 0);
    if (name === "mallet"){ voices.mallet(t, 0.85); voices.mallet(t + 0.42, 0.95); voices.mallet(t + 0.84, 1.1); }
    else if (voices[name]) voices[name](t);
  },
  state: () => ({rec: recState, stage, level, hushed, buses: rec ? Object.fromEntries(Object.keys(rec).map(k => [k, +rec[k].bus.gain.value.toFixed(3)])) : null}),
  engine: makeEngine
};
})();
