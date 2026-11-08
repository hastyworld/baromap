// 광선 선택(06 6절): 누른 자리 → 장면 요소 id. 누름·끌기 구분, 두 번 누르기(들어가기), 길게 누르기(여러 개 고르기, 휴대폰).
const MOVE = 6; // px: 이보다 많이 움직이면 돌리기(끌기)로 본다
const DOUBLE = 380; // ms
const LONG = 550; // ms

/**
 * @param {*} T three
 * @param {{ camera, dom: HTMLElement, objects: () => any[], idOf: (hit) => string|null, keeps?: (point) => boolean,
 *           onPick: (id: string|null, { add: boolean, double: boolean, hit }) => void }} o
 */
export function createPicker(T, { camera, dom, objects, idOf, keeps = () => true, onPick }) {
  const ray = new T.Raycaster();
  const v = new T.Vector2();
  let down = null;
  let last = { t: 0, id: null };
  let longTimer = 0;
  const hitAt = (x, y) => {
    const r = dom.getBoundingClientRect();
    v.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v, camera);
    for (const h of ray.intersectObjects(objects(), false)) {
      if (!keeps(h.point)) continue;
      const id = idOf(h);
      if (id) return { id, hit: h };
    }
    return { id: null, hit: null };
  };
  const onDown = (e) => {
    if (e.button > 0) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now(), long: false };
    clearTimeout(longTimer);
    if (e.pointerType === 'touch') {
      longTimer = setTimeout(() => {
        if (!down) return;
        down.long = true;
        const { id, hit } = hitAt(down.x, down.y);
        if (id) { navigator.vibrate?.(15); onPick(id, { add: true, double: false, hit }); }
      }, LONG);
    }
  };
  const onMove = (e) => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > MOVE) { down = null; clearTimeout(longTimer); } };
  const onUp = (e) => {
    clearTimeout(longTimer);
    const d = down;
    down = null;
    if (!d || d.long) return;
    const { id, hit } = hitAt(e.clientX, e.clientY);
    const now = performance.now();
    const double = Boolean(id) && last.id === id && now - last.t < DOUBLE;
    last = double ? { t: 0, id: null } : { t: now, id };
    onPick(id, { add: e.shiftKey || e.ctrlKey || e.metaKey, double, hit });
  };
  const onCancel = () => { down = null; clearTimeout(longTimer); };
  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onCancel);
  return {
    hitAt,
    dispose() {
      clearTimeout(longTimer);
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onCancel);
    },
  };
}
