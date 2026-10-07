/* REAL rig: physically-based sky, sun, image-based ambient light, fog and renderer settings.
   Needs THREE r128 plus examples/js/objects/Sky.js (THREE.Sky). */
(function(){
"use strict";
const REAL = window.REAL = window.REAL || {};

REAL.rig = {
  create: function(THREE, renderer, scene, o){
    o = o || {};
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    REAL.core && (REAL.core.maxAniso = renderer.capabilities.getMaxAnisotropy());

    const sky = new THREE.Sky();
    sky.scale.setScalar(4000);
    const su = sky.material.uniforms;
    su.turbidity.value = 5.5; su.rayleigh.value = 1.4; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.82;
    scene.add(sky);

    const sun = new THREE.DirectionalLight(0xfff2df, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(o.shadowSize || 4096, o.shadowSize || 4096);
    const sc = sun.shadow.camera;
    sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.near = 20; sc.far = 260;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.06;
    scene.add(sun); scene.add(sun.target);

    const fill = new THREE.HemisphereLight(0xcfe0ff, 0x5b5140, 0.18);
    scene.add(fill);

    scene.fog = new THREE.Fog(0xc9d6e2, 160, 700);

    /* Image-based ambient light comes from a controllable gradient dome rather than the Sky shader,
       whose raw radiance is far too strong to use as fill light. */
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    /* dome with per-vertex colours: zenith blue -> pale horizon -> earth below, plus a soft glow toward the sun */
    const domeGeo = new THREE.SphereGeometry(40, 96, 48);
    const domeCol = new Float32Array(domeGeo.attributes.position.count * 3);
    domeGeo.setAttribute("color", new THREE.BufferAttribute(domeCol, 3));
    const dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({side: THREE.BackSide, vertexColors: true, toneMapped: false, depthWrite: false}));
    envScene.add(dome);
    const envC = { top: new THREE.Color(), horizon: new THREE.Color(), bottom: new THREE.Color(), sun: new THREE.Color(), k: 1 };
    function paintDome(dir){
      const pa = domeGeo.attributes.position, v = new THREE.Vector3(), c = new THREE.Color(), t = new THREE.Color();
      for (let i = 0; i < pa.count; i++){
        v.fromBufferAttribute(pa, i).normalize();
        if (v.y >= 0) c.copy(envC.horizon).lerp(envC.top, Math.pow(v.y, 0.55));
        else c.copy(envC.horizon).lerp(envC.bottom, Math.pow(-v.y, 0.35));
        const g = Math.max(0, v.dot(dir));
        t.copy(envC.sun).multiplyScalar(Math.pow(g, 24) * 2.5 + Math.pow(g, 4) * 0.25);
        c.add(t).multiplyScalar(envC.k);
        domeCol[i*3] = c.r; domeCol[i*3+1] = c.g; domeCol[i*3+2] = c.b;
      }
      domeGeo.attributes.color.needsUpdate = true;
    }
    let envRT = null;
    const lin = h => new THREE.Color(h).convertSRGBToLinear();

    const sunDir = new THREE.Vector3();
    function setSun(elevDeg, azDeg){
      const phi = THREE.MathUtils.degToRad(90 - elevDeg), theta = THREE.MathUtils.degToRad(azDeg);
      sunDir.setFromSphericalCoords(1, phi, theta);
      su.sunPosition.value.copy(sunDir);
      paintDome(sunDir);
      sun.position.copy(sunDir).multiplyScalar(140);
      sun.target.position.set(0, 0, 0);
      if (envRT) envRT.dispose();
      envRT = pmrem.fromScene(envScene, 0.02);
      scene.environment = envRT.texture;
    }

    function theme(dark){
      if (dark){
        /* late-evening light: low warm sun, deeper sky, lit windows handled by the scene */
        su.turbidity.value = 8; su.rayleigh.value = 2.6; su.mieCoefficient.value = 0.006;
        sun.color.set(0xffa860); sun.intensity = 1.6; fill.intensity = 0.0;
        envC.top.copy(lin("#3a4a6e")); envC.horizon.copy(lin("#b98a72")); envC.bottom.copy(lin("#2a2620"));
        envC.sun.copy(lin("#ff9a50")); envC.k = 0.55;
        renderer.toneMappingExposure = 0.9;
        scene.fog.color.set(0x8a7f86);
        setSun(6, o.sunAzimuth == null ? 325 : o.sunAzimuth);
      } else {
        su.turbidity.value = 5.5; su.rayleigh.value = 1.4; su.mieCoefficient.value = 0.004;
        sun.color.set(0xfff0dc); sun.intensity = 1.9; fill.intensity = 0.0;
        envC.top.copy(lin("#6f97c9")); envC.horizon.copy(lin("#cfdbe6")); envC.bottom.copy(lin("#6b6253"));
        envC.sun.copy(lin("#fff1de")); envC.k = 0.36;
        renderer.toneMappingExposure = 1.0;
        scene.fog.color.set(0xc9d6e2);
        setSun(o.sunElevation == null ? 38 : o.sunElevation, o.sunAzimuth == null ? 325 : o.sunAzimuth);
      }
    }
    theme(!!o.dark);
    return { sky, sun, fill, setSun, theme, get envMap(){ return envRT && envRT.texture; } };
  }
};
})();
