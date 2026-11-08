// 실물 보기(22 지시서 1~4절): 재질(PBR)·하늘·환경광·그림자·앰비언트 오클루전, 품질 단계, 큰 사진 저장. three.js 0.160 예제 모듈.
// 하늘은 해 위치와 맞도록 Sky 셰이더로 그리고 그 하늘로 환경광을 만든다(HDRI 대신, 22 지시서 2절 구현 메모).
import { createPbr } from './pbr.js';

const EX = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/';
let addons = null;
const loadAddons = () => (addons ||= Promise.all([
  import(`${EX}objects/Sky.js/+esm`), import(`${EX}postprocessing/EffectComposer.js/+esm`), import(`${EX}postprocessing/RenderPass.js/+esm`),
  import(`${EX}postprocessing/GTAOPass.js/+esm`), import(`${EX}postprocessing/OutputPass.js/+esm`),
]).then(([a, b, c, d, e]) => ({ Sky: a.Sky, EffectComposer: b.EffectComposer, RenderPass: c.RenderPass, GTAOPass: d.GTAOPass, OutputPass: e.OutputPass }))
  .catch((err) => { addons = null; throw err; }));

export const QUALITY = ['fast', 'normal', 'good'];
export const QUALITY_LABEL = { auto: '자동', fast: '빠름', normal: '보통', good: '좋음' };
const SHADOW = { fast: 0, normal: 2048, good: 4096 };
export const PHOTO_NOTE = '바로맵 모델 렌더 — 시공 참고용, 실제와 다를 수 있음';

/** 모델 좌표(x 동, y 북, z 위) → 화면 좌표(x, 위 y, 남 z) */
const toWorld = (v) => [v[0], v[2], -v[1]];

/**
 * @param {{ T, renderer, scene, camera, root, sun, hemi, setRender }} stage
 */
export async function createReal(stage) {
  const { T, renderer, scene, camera } = stage;
  const A = await loadAddons();
  const pbr = createPbr(T, { anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
  const pmrem = new T.PMREMGenerator(renderer);
  const sky = new A.Sky();
  sky.scale.setScalar(20000);
  Object.assign(sky.material.uniforms.turbidity, { value: 5 });
  sky.material.uniforms.rayleigh.value = 1.4;
  sky.material.uniforms.mieCoefficient.value = 0.004;
  sky.material.uniforms.mieDirectionalG.value = 0.8;
  let env = null;
  let composer = null;
  let gtao = null;
  const st = { on: false, quality: 'normal', overcast: false, sunDir: [0.3, -0.6, 0.75], ext: [-50, -50, 0, 50, 50, 30], moving: false };
  const saved = { bg: scene.background, hemi: stage.hemi.intensity, sun: stage.sun.intensity, sky: stage.hemi.color.clone(), ground: stage.hemi.groundColor.clone() };

  function makeEnv() {
    env?.dispose();
    if (st.overcast) {
      const s = new T.Scene();
      s.background = new T.Color('#c9ced6');
      env = pmrem.fromScene(s, 0.04);
    } else {
      const s = new T.Scene();
      s.add(sky);
      env = pmrem.fromScene(s, 0.01);
      s.remove(sky);
    }
    scene.environment = env.texture;
    // 하늘 상자는 카메라 먼 쪽 평면에 잘리므로 환경광 텍스처를 배경으로 쓴다
    if (st.on) scene.background = env.texture;
  }

  function placeSun() {
    const [x, y, z] = toWorld(st.sunDir);
    sky.material.uniforms.sunPosition.value.set(x, y, z);
    const e = st.ext;
    const c = new T.Vector3((e[0] + e[3]) / 2, (e[2] + e[5]) / 2, -(e[1] + e[4]) / 2);
    const r = Math.max(20, Math.hypot(e[3] - e[0], e[4] - e[1], e[5] - e[2]) / 2);
    const sun = stage.sun;
    sun.position.set(c.x + x * r * 2, c.y + Math.max(0.05, y) * r * 2, c.z + z * r * 2);
    sun.target.position.copy(c);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: r * 5 });
    cam.updateProjectionMatrix();
    // 해가 지면 어둡게
    const day = Math.max(0, Math.min(1, y * 4 + 0.15));
    sun.intensity = st.overcast ? 0.6 : 2.4 * day;
    // 하늘빛과 땅에서 튀는 빛(그늘이 너무 파랗고 어둡지 않게)
    stage.hemi.color.set(st.overcast ? '#dfe3e8' : '#e6edf5');
    stage.hemi.groundColor.set('#9a8b6e');
    stage.hemi.intensity = (st.overcast ? 1.0 : 0.75) * Math.max(0.3, day);
  }

  function setQuality(q) {
    st.quality = q;
    const r = renderer;
    const size = SHADOW[q];
    r.shadowMap.enabled = st.on && size > 0;
    r.shadowMap.type = T.PCFSoftShadowMap;
    stage.sun.castShadow = st.on && size > 0;
    if (size && stage.sun.shadow.mapSize.x !== size) {
      stage.sun.shadow.mapSize.set(size, size);
      stage.sun.shadow.map?.dispose();
      stage.sun.shadow.map = null;
    }
    stage.sun.shadow.bias = -0.0004;
    stage.sun.shadow.normalBias = 0.03;
    if (st.on && q === 'good' && !composer) {
      const w = r.domElement.width;
      const h = r.domElement.height;
      composer = new A.EffectComposer(r);
      composer.addPass(new A.RenderPass(scene, camera));
      gtao = new A.GTAOPass(scene, camera, w, h);
      gtao.output = A.GTAOPass.OUTPUT.Default;
      composer.addPass(gtao);
      composer.addPass(new A.OutputPass());
    }
    if (q !== 'good' && composer) { composer.dispose?.(); composer = null; gtao = null; }
  }

  function render() {
    if (composer && !st.moving) {
      const w = renderer.domElement.width;
      const h = renderer.domElement.height;
      if (composer._w !== w || composer._h !== h) { composer.setPixelRatio(1); composer.setSize(w, h); composer._w = w; composer._h = h; }
      composer.render();
    } else renderer.render(scene, camera);
  }

  return {
    pbr,
    get on() { return st.on; },
    get quality() { return st.quality; },
    get overcast() { return st.overcast; },
    enable(quality = st.quality) {
      st.on = true;
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.6;
      makeEnv();
      setQuality(quality);
      placeSun();
      stage.setRender(render);
    },
    disable() {
      st.on = false;
      renderer.toneMapping = T.NoToneMapping;
      scene.background = saved.bg;
      scene.environment = null;
      stage.hemi.intensity = saved.hemi;
      stage.hemi.color.copy(saved.sky);
      stage.hemi.groundColor.copy(saved.ground);
      stage.sun.intensity = saved.sun;
      stage.sun.position.set(80, 160, 60);
      setQuality(st.quality);
      stage.setRender(null);
    },
    setQuality,
    setSun(dir) { st.sunDir = dir; if (st.on) { placeSun(); makeEnv(); } },
    setOvercast(v) { st.overcast = v; if (st.on) { makeEnv(); placeSun(); } },
    setMoving(v) { st.moving = v; },
    /** 장면이 바뀌면 그림자 범위를 맞추고 그림자를 켠다 */
    prepare(group, ext) {
      st.ext = ext;
      if (st.on) placeSun();
      group.traverse((o) => { if (o.isMesh) { o.castShadow = st.on && st.quality !== 'fast'; o.receiveShadow = st.on && st.quality !== 'fast'; } });
    },
    dispose() { pbr.dispose(); env?.dispose(); pmrem.dispose(); composer?.dispose?.(); },
    render,
  };
}

/**
 * 큰 사진: 타일로 나눠 그린 뒤 이어 붙이고, 왼쪽 아래에 "렌더·참고용"과 모델 버전을 쓴다.
 * @returns {Promise<Blob>}
 */
export async function takePhoto(stage, real, { maxSide = 4096, label = '', tile = 1024 } = {}) {
  const { renderer, camera } = stage;
  const cap = Math.min(maxSide, renderer.capabilities.maxTextureSize || 4096);
  const aspect = camera.aspect;
  const W = Math.round(aspect >= 1 ? cap : cap * aspect);
  const H = Math.round(aspect >= 1 ? cap / aspect : cap);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  const pr = renderer.getPixelRatio();
  const size = renderer.getSize(new stage.T.Vector2());
  renderer.setPixelRatio(1);
  try {
    for (let y = 0; y < H; y += tile) {
      for (let x = 0; x < W; x += tile) {
        const tw = Math.min(tile, W - x);
        const th = Math.min(tile, H - y);
        camera.setViewOffset(W, H, x, y, tw, th);
        renderer.setSize(tw, th, false);
        if (real?.on) real.render(); else renderer.render(stage.scene, camera);
        ctx.drawImage(renderer.domElement, x, y);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    camera.clearViewOffset();
    renderer.setPixelRatio(pr);
    renderer.setSize(size.x, size.y, false);
    camera.updateProjectionMatrix();
  }
  const fs = Math.max(14, Math.round(W / 90));
  const text = `${PHOTO_NOTE}${label ? ` · ${label}` : ''}`;
  ctx.font = `600 ${fs}px Pretendard, 'Malgun Gothic', sans-serif`;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(fs * 0.6, H - fs * 2.4, tw + fs * 1.2, fs * 1.8);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, fs * 1.2, H - fs * 1.05);
  return new Promise((r) => out.toBlob(r, 'image/png'));
}

/** 처음 몇 초의 fps로 품질 고르기 */
export const autoQuality = (fps, mobile) => (fps < 24 || mobile ? (fps < 40 ? 'fast' : 'normal') : fps < 45 ? 'normal' : 'good');
