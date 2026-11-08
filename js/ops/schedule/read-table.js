// 표 모양 엑셀·CSV 읽기(28 지시서 1절 4): 머리글을 보고 열을 짐작하고, 모자라면 사람이 열을 고른다.
// MS Project·P6에서 엑셀로 내보낸 표(개요 수준·들여쓰기로 요약 행 판단)도 이 길로 읽는다.
import { activity, parseFloorRange, normFloor } from './core.js';
import { cellText } from './xlsx.js';
import { cellDate } from './read-standard.js';

export const TABLE_FIELDS = {
  actId: ['작업ID', '작업 ID', 'ID', '번호', '코드', '작업코드', 'Activity ID', 'Task ID', 'Unique ID', '고유 ID'],
  name: ['작업명', '작업 이름', '이름', '공종명', '공정명', '내용', '항목', 'Task Name', 'Name', 'Activity Name', '작업'],
  start: ['시작', '시작일', '착수', '착수일', '계획시작', '시작 날짜', 'Start', 'Start Date', 'Planned Start'],
  finish: ['종료', '종료일', '완료', '완료일', '끝', '계획종료', '완료 날짜', 'Finish', 'End', 'Finish Date', 'Planned Finish'],
  outline: ['개요 수준', '개요수준', 'Outline Level', '수준', '레벨'],
  wbs: ['WBS', 'WBS 코드'],
  building: ['동', '동명'],
  floors: ['층', '층수', '층 범위', '층범위'],
  trade: ['공종', '공종구분', '공종 구분', 'Trade'],
  percent: ['진행률', '완료율', '% 완료', '%완료', '% Complete', '진척률'],
  preds: ['선행 작업', '선행작업', 'Predecessors', '선행'],
  actualStart: ['실제 시작', '실적시작', '실적 시작', 'Actual Start'],
  actualFinish: ['실제 완료', '실적종료', '실적 완료', 'Actual Finish'],
};
export const TABLE_LABELS = { actId: '작업ID', name: '작업 이름', start: '시작일', finish: '종료일', outline: '개요 수준', wbs: 'WBS', building: '동', floors: '층', trade: '공종', percent: '진행률', preds: '선행 작업', actualStart: '실적 시작', actualFinish: '실적 종료' };
const NEED = ['name', 'start', 'finish'];

const squash = (s) => String(s ?? '').replace(/\s/g, '').toLowerCase();

export function guessColumns(row) {
  const map = {};
  (row || []).forEach((c, i) => {
    const t = squash(cellText(c));
    if (!t) return;
    for (const [field, names] of Object.entries(TABLE_FIELDS)) if (!(field in map) && names.some((n) => squash(n) === t)) { map[field] = i; return; }
  });
  return map;
}

/** 머리글 줄 찾기: 알아본 열이 가장 많은 줄(처음 30줄) */
export function findHeader(grid) {
  let best = { row: -1, map: {}, score: 0 };
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const map = guessColumns(grid[r]);
    const score = Object.keys(map).length + NEED.filter((f) => f in map).length;
    if (score > best.score) best = { row: r, map, score };
  }
  return best;
}

/**
 * @param {any[][]} grid 칸 표
 * @param {{ header?: number, map?: Record<string, number> }} o 사람이 고른 머리글 줄·열
 * @returns {{ format: 'table', activities?: any[], needsMapping?: boolean, header: number, map: any, headers: string[], warnings: string[] }}
 */
export function readTable(grid, o = {}) {
  const found = o.header != null ? { row: o.header, map: o.map || guessColumns(grid[o.header]) } : findHeader(grid);
  const header = found.row;
  const map = { ...found.map, ...(o.map || {}) };
  const headers = (grid[Math.max(0, header)] || []).map(cellText);
  if (header < 0 || NEED.some((f) => !(f in map))) return { format: 'table', needsMapping: true, header: Math.max(0, header), map, headers, warnings: [] };
  const warnings = [];
  const acts = [];
  const byNo = new Map();
  for (let r = header + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const raw = row[map.name];
    const name = cellText(raw);
    if (!name) continue;
    const errors = [];
    const d = (f) => {
      if (!(f in map)) return null;
      const x = cellDate(row[map[f]]);
      if (x.bad) errors.push(`'${x.bad}'을(를) 날짜로 읽지 못했습니다.`);
      return x.iso;
    };
    const indent = typeof raw?.v === 'string' ? raw.v.length - raw.v.trimStart().length : 0;
    const outline = 'outline' in map ? Number(cellText(row[map.outline])) || null : null;
    const floors = 'floors' in map ? parseFloorRange(cellText(row[map.floors])) || (normFloor(cellText(row[map.floors])) ? { from: normFloor(cellText(row[map.floors])), to: normFloor(cellText(row[map.floors])) } : null) : null;
    const no = cellText(row[map.actId]);
    const preds = 'preds' in map ? cellText(row[map.preds]).split(/[,;]/).map((p) => /^(\w[\w.-]*?)(FS|SS|FF|SF)?(?:([+-]\d+(?:\.\d+)?)\s*(?:일|d|days?)?)?$/i.exec(p.trim())).filter(Boolean).map((m) => ({ id: m[1], type: (m[2] || 'FS').toUpperCase(), lag: Number(m[3] || 0) })) : [];
    const a = activity({
      actId: no, name: name.trim(), building: 'building' in map ? cellText(row[map.building]) : '',
      fromFloor: floors?.from, toFloor: floors?.to, trade: 'trade' in map ? cellText(row[map.trade]) : '',
      start: d('start'), finish: d('finish'), actualStart: d('actualStart'), actualFinish: d('actualFinish'),
      percent: 'percent' in map ? cellText(row[map.percent]) : null, preds,
      outline: outline ?? (indent ? Math.floor(indent / 2) + 1 : null),
      wbs: 'wbs' in map && cellText(row[map.wbs]) ? [cellText(row[map.wbs])] : [],
      errors, source: { row: r + 1 },
    });
    if (a.outline == null && acts.some((x) => x.outline != null)) a.outline = 1;
    if (no) byNo.set(no, a);
    acts.push(a);
  }
  // 개요 수준으로 WBS 경로를 채운다(요약 행 이름들)
  const stack = [];
  for (const a of acts) {
    if (a.outline == null) continue;
    stack.length = Math.max(0, a.outline - 1);
    if (!a.wbs.length) a.wbs = stack.filter(Boolean);
    stack[a.outline - 1] = a.name;
  }
  if (!acts.length) warnings.push('표에서 공정 행을 찾지 못했습니다.');
  return { format: 'table', activities: acts, header, map, headers, warnings };
}

// ---------------------------------------------------------------- CSV

/** CSV 글자 → 칸 표(따옴표·줄바꿈 처리). 날짜는 글자 그대로 둔다(cellDate가 바꾼다) */
export function csvGrid(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const src = text.replace(/^﻿/, '');
  const sep = (src.split('\n')[0].match(/\t/g) || []).length > (src.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((v) => {
    const t = v.trim();
    if (!t) return null;
    return /^-?\d+(\.\d+)?$/.test(t) && t.length < 6 ? { v: Number(t), t: 'n', fill: null } : { v: t, t: 's', fill: null };
  }));
}
