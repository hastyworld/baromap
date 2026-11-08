// 모델 생성 워커: 시트 정보 + 시트 모양(.geom.json)을 받아 buildModel을 돌린다(큰 계산은 화면을 멈추지 않게).
// 메시지: { id, sheets, geoms: [[sheetId, packedGeom, triage|null]], progress, siteId, setId, drawingFiles } → { id, result(+findings 규칙 검사) } | { id, error }
import { buildModel } from './build.js';
import { unpackSheet } from '../cad/flatten.js';
import { applyTriage } from '../cad/triage.js';
import { runChecks } from './checks.js';

self.onmessage = (ev) => {
  const { id, sheets, geoms, progress, siteId, setId, drawingFiles = [] } = ev.data || {};
  try {
    const geomBySheet = new Map((geoms || []).map(([sid, g, t]) => [sid, applyTriage(unpackSheet(g), t)]));
    const result = buildModel({ siteId, setId, sheets, geomBySheet, progress });
    const findings = runChecks({ files: result.files, report: result.report, sheets, drawingFiles });
    self.postMessage({ id, result: { ...result, findings } });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
