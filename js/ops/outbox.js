// 오프라인 입력 대기열(11 지시서 2-3절). 화면과 무관: db·보내기 함수를 밖에서 넣어 준다(Node 테스트 가능).
// 비울 때는 파일 먼저, 그다음 행. id는 브라우저가 만든 것이라 두 번 올려도 같은 행이다(upsert).
// 충돌: 서버의 updatedAt이 편집을 시작할 때 값보다 새로우면 서버 것을 두고, 내 것은 충돌본으로 남겨 사람이 고르게 한다.

const rowKey = (kind, id) => `r:${kind}:${id}`;
const fileKey = (bucket, path) => `f:${bucket}:${path}`;
const conflictKey = (kind, id) => `c:${kind}:${id}`;
const newer = (a, b) => Boolean(a && b && Date.parse(a) > Date.parse(b));

/**
 * @param {{
 *   db: { all: () => Promise<any[]>, put: (rec: any) => Promise<any>, del: (ids: string[]) => Promise<any> },
 *   sendRow: (kind: string, row: any) => Promise<any>,
 *   sendFile: (bucket: string, path: string, blob: any, mime: string) => Promise<any>,
 *   serverRow: (kind: string, id: string) => Promise<any>,
 *   isNetwork: (err: any) => boolean,
 *   now?: () => Date,
 *   onChange?: () => void,
 * }} o
 */
export function createOutbox({ db, sendRow, sendFile, serverRow, isNetwork, now = () => new Date(), onChange = () => {} }) {
  let flushing = null;

  async function entries(type) { return (await db.all()).filter((e) => e.type === type).sort((a, b) => String(a.at).localeCompare(String(b.at))); }

  async function run() {
    const out = { files: 0, rows: 0, conflicts: 0, failed: 0, stopped: false };
    for (const f of await entries('file')) {
      try {
        await sendFile(f.bucket, f.path, f.blob, f.mime);
        await db.del([f.id]);
        out.files++;
      } catch (err) {
        if (isNetwork(err)) { out.stopped = true; return out; }
        // 이미 올라간 파일은 성공으로 친다(두 번 올려도 같은 경로)
        if (/already exists|Duplicate/i.test(String(err?.message || err))) { await db.del([f.id]); out.files++; continue; }
        await db.put({ ...f, error: String(err?.message || err) });
        out.failed++;
      }
    }
    for (const r of await entries('row')) {
      try {
        const server = await serverRow(r.kind, r.row.id);
        if (server && newer(server.updatedAt, r.baseUpdatedAt)) {
          await db.put({ id: conflictKey(r.kind, r.row.id), type: 'conflict', kind: r.kind, row: r.row, server, at: now().toISOString() });
          await db.del([r.id]);
          out.conflicts++;
          continue;
        }
        await sendRow(r.kind, r.row);
        await db.del([r.id]);
        out.rows++;
      } catch (err) {
        if (isNetwork(err)) { out.stopped = true; return out; }
        // 권한·검증 오류는 다시 보내도 같다 → 사람이 보게 충돌본으로 옮긴다
        await db.put({ id: conflictKey(r.kind, r.row.id), type: 'conflict', kind: r.kind, row: r.row, server: null, error: String(err?.message || err), at: now().toISOString() });
        await db.del([r.id]);
        out.failed++;
      }
    }
    return out;
  }

  const box = {
    async addRow(kind, row, baseUpdatedAt = null) {
      const id = rowKey(kind, row.id);
      const prev = (await db.all()).find((e) => e.id === id);
      await db.put({ id, type: 'row', kind, row, baseUpdatedAt: prev ? prev.baseUpdatedAt : baseUpdatedAt, at: prev?.at || now().toISOString() });
      onChange();
    },
    async addFile(bucket, path, blob, mime) {
      await db.put({ id: fileKey(bucket, path), type: 'file', bucket, path, blob, mime, at: now().toISOString() });
      onChange();
    },
    async dropFile(bucket, path) {
      await db.del([fileKey(bucket, path)]);
      onChange();
    },
    pendingRows: async (kind) => (await entries('row')).filter((e) => !kind || e.kind === kind).map((e) => e.row),
    async pending() {
      const all = await db.all();
      return all.filter((e) => e.type === 'row' || e.type === 'file').map(({ id, type, kind, path, at, error }) => ({ id, type, kind, path, at, error }));
    },
    conflicts: () => entries('conflict'),
    // 충돌본 고르기: mine이면 내 것으로 서버를 덮는다
    async resolve(id, mine) {
      const c = (await db.all()).find((e) => e.id === id);
      if (!c) return;
      if (mine) await sendRow(c.kind, c.row);
      await db.del([id]);
      onChange();
    },
    flush() {
      if (flushing) return flushing;
      flushing = run().finally(() => { flushing = null; onChange(); });
      return flushing;
    },
  };
  return box;
}
