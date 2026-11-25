/** Reference photos: the left-panel list (add, compare, remove, auto-fit) and the comparison overlay over the 3D view. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { studio } from '../app.ts';
import { composeCompare } from '../photo/compose.ts';
import type { CompareFrame, FitSummary, RefItem } from '../photo/references.ts';
import { useDoc, useRefs } from './hooks.ts';

const STATUS: Record<RefItem['status'], string> = { loading: '分析中…', ready: '', noface: '找不到臉，換一張清楚、正面或 3/4 的照片', error: '讀取失敗' };
type Expression = 'estimate' | 'neutral' | 'keep';

/** Add image files as reference photos of the open portrait (one at a time, each undoable). */
export async function addReferenceFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (/heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name)) {
      studio.toast(`${f.name}：瀏覽器讀不了 HEIC，請先轉成 JPEG（例如用「預覽程式」輸出）`, 'error');
      continue;
    }
    if (!f.type.startsWith('image/') && !/\.(jpe?g|png|webp)$/i.test(f.name)) {
      studio.toast(`${f.name} 不是 JPEG／PNG／WebP 圖片`, 'error');
      continue;
    }
    try {
      const it = await studio.refs.add(f, { note: f.name.replace(/\.[^.]+$/, '') });
      if (it.status === 'noface') studio.toast(`已加入「${it.note}」，但找不到臉：換一張清楚、看得到整張臉的照片`, 'error');
      else studio.toast(`已加入參考照片「${it.note}」${it.align ? `（目前誤差 ${it.align.error}%）` : ''}`, 'success');
    } catch (e) {
      studio.toast(`加入失敗：${(e as Error).message}`, 'error');
    }
  }
}

function compare(refId: string, frame?: CompareFrame) {
  studio.refs.compare(refId, { frame }).catch((e: Error) => studio.toast(`比對失敗：${e.message}`, 'error'));
}

async function runFit(o: { expression: Expression; refIds?: string[]; outline?: boolean }) {
  try {
    const r = await studio.refs.fit(o);
    studio.toast(r.applied ? `擬合完成：特徵點 ${r.error.before}→${r.error.after}%${r.outline ? `、輪廓 ${r.outline.before}→${r.outline.after}%` : ''}（可復原）` : '擬合結果和目前一樣，沒有變更', 'success');
    const c = studio.refs.store.getState().compare;
    if (c && r.applied) compare(c.refId);
  } catch (e) {
    studio.toast(`擬合失敗：${(e as Error).message}`, 'error');
  }
}

function FitSummaryView({ fit }: { fit: FitSummary }) {
  return (
    <details className="pt-fit-summary">
      <summary>
        上次擬合：特徵點 {fit.error.before}→{fit.error.after}%{fit.outline ? `・輪廓 ${fit.outline.before}→${fit.outline.after}%` : ''}・{fit.changed.length} 個參數{fit.applied ? '' : '（未套用）'}
      </summary>
      <ul>
        {fit.changed.slice(0, 24).map((c) => (
          <li key={c.key} title={`${c.key}・信心 ${Math.round(c.confidence * 100)}%`}>
            <span>{c.label}</span>
            <span className="pt-num">
              {c.from}→{c.to}
            </span>
            <span className="pt-conf" style={{ width: `${Math.round(c.confidence * 36)}px` }} />
          </li>
        ))}
      </ul>
      <p className="hint">長條＝照片對這個參數的把握。只從照片很難判斷的（例如鼻子深度）會留在原值附近；不滿意可以復原（⌘Z）。</p>
    </details>
  );
}

export function ReferencesSection() {
  const items = useRefs((s) => s.items);
  const busy = useRefs((s) => s.busy);
  const fit = useRefs((s) => s.fit);
  const hasExpr = useDoc((s) => Object.keys(s.portrait.params).some((k) => k.startsWith('expr.')));
  const [expression, setExpression] = useState<Expression>('estimate');
  const [outline, setOutline] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ready = items.filter((i) => i.status === 'ready');
  return (
    <section className="pt-refs">
      <h4>
        參考照片 {items.length ? <span className="muted">{items.length}</span> : null}
        <button className="mini pt-refs-add" aria-label="加入參考照片" title="加入照片（也可以把照片拖進視窗）。照片只在這台電腦上分析，不會上傳。" disabled={busy === 'adding'} onClick={() => fileRef.current?.click()}>
          {busy === 'adding' ? '分析中…' : '＋ 加入'}
        </button>
      </h4>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void addReferenceFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {items.length === 0 ? <p className="hint">加入 1–3 張清楚的照片（正面、3/4 側面），可以和人像比對，並自動擬合臉型。照片只在本機分析，不會上傳。</p> : null}
      {items.map((it) => (
        <div key={it.id} className="pt-ref">
          <button className="pt-ref-thumb" aria-label={`比對參考照片「${it.note || it.id}」`} title="和人像比對" disabled={it.status !== 'ready' || !!busy} onClick={() => compare(it.id)}>
            {it.url ? <img src={it.url} alt="" /> : <span>…</span>}
          </button>
          <div className="pt-ref-info">
            <div className="pt-ref-note" title={it.note || it.id}>
              {it.note || it.id}
            </div>
            {it.status === 'ready' && it.align ? (
              <>
                <div className="muted">
                  誤差 {it.align.error}%{it.align.outline !== null ? `・輪廓 ${it.align.outline}%` : ''}
                </div>
                <div className="muted">
                  頭轉 {it.align.camera.yaw}°・焦距約 {it.align.camera.focal35mm} mm{it.focal35 ? '（EXIF）' : ''}
                </div>
              </>
            ) : (
              <div className={it.status === 'loading' ? 'muted' : 'warn'}>{STATUS[it.status]}</div>
            )}
            <div className="pt-ref-actions">
              <button className="mini" disabled={it.status !== 'ready' || !!busy} onClick={() => compare(it.id)}>
                比對
              </button>
              <button className="mini" aria-label={`移除參考照片「${it.note || it.id}」`} title="從這個人像移除（可復原）" onClick={() => studio.refs.remove(it.id)}>
                移除
              </button>
            </div>
          </div>
        </div>
      ))}
      {items.length ? (
        <div className="pt-fit">
          <label title="照片裡的表情：照著做、擬合後歸零，或不動目前的表情">
            表情
            <select aria-label="擬合時的表情" value={expression} onChange={(e) => setExpression(e.target.value as Expression)}>
              <option value="estimate">照片的表情</option>
              <option value="neutral">擬合後歸零</option>
              <option value="keep">不動表情</option>
            </select>
          </label>
          <label className="pt-fit-check" title="實驗功能：再用下顎、下巴、臉頰的外輪廓調整臉寬（照片有 EXIF 焦距時比較準）">
            <input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} />
            也對齊臉部輪廓（實驗）
          </label>
          <button className="primary" disabled={!ready.length || !!busy} title="依照片調整臉部參數（一個可復原的步驟）" onClick={() => void runFit({ expression, outline })}>
            {busy === 'fit' ? '擬合中…' : `自動擬合（${ready.length} 張）`}
          </button>
          <button disabled={!hasExpr} title="移除所有表情參數（expr.*），保留長相" onClick={() => studio.run({ cmd: 'portrait.neutralize', args: {} })}>
            表情歸零
          </button>
        </div>
      ) : null}
      {fit ? <FitSummaryView fit={fit} /> : null}
    </section>
  );
}

const MODES = [
  ['overlay', '疊合'],
  ['side', '並排'],
  ['landmarks', '特徵點'],
] as const;
type Mode = (typeof MODES)[number][0];

function downloadCanvas(c: HTMLCanvasElement, name: string) {
  c.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

/** The photo next to / under the portrait seen by the photo's camera, with measured differences. */
export function CompareOverlay() {
  const view = useRefs((s) => s.compare);
  const busy = useRefs((s) => s.busy);
  const params = useDoc((s) => s.portrait.params);
  const [mode, setMode] = useState<Mode>('overlay');
  const [opacity, setOpacity] = useState(0.5);
  const [landmarks, setLandmarks] = useState<string | null>(null);
  const stale = useMemo(() => !!view && view.params !== params && JSON.stringify(view.params) !== JSON.stringify(params), [view, params]);

  useEffect(() => {
    setLandmarks(null);
    if (!view || mode !== 'landmarks') return;
    let live = true;
    void composeCompare(view, 'landmarks').then((c) => live && setLandmarks(c.toDataURL('image/jpeg', 0.9)));
    return () => {
      live = false;
    };
  }, [view, mode]);

  if (!view) return busy === 'compare' ? <div className="pt-compare-busy">比對中…</div> : null;
  const r = view.report;
  const worst = [...r.measures].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return (
    <div className="pt-compare" role="dialog" aria-label="照片比對">
      <header>
        <strong className="pt-compare-title">比對：{r.note || r.refId}</strong>
        <div className="segmented" role="group" aria-label="比對方式">
          {MODES.map(([m, label]) => (
            <button key={m} className={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        {mode === 'overlay' ? (
          <label className="pt-amount">
            人像
            <input type="range" min={0} max={1} step={0.05} value={opacity} aria-label="人像不透明度" onChange={(e) => setOpacity(Number(e.target.value))} />
            <span className="pt-num">{Math.round(opacity * 100)}%</span>
          </label>
        ) : null}
        <div className="segmented" role="group" aria-label="比對範圍">
          {([['face', '臉部'], ['head', '整顆頭']] as const).map(([f, label]) => (
            <button key={f} className={view.frame === f ? 'on' : ''} aria-pressed={view.frame === f} disabled={!!busy} title={f === 'head' ? '含頭頂、耳朵與頭部輪廓' : '裁到臉部'} onClick={() => view.frame !== f && compare(view.refId, f)}>
              {label}
            </button>
          ))}
        </div>
        {stale ? (
          <button className="primary" disabled={!!busy} onClick={() => compare(view.refId)}>
            {busy === 'compare' ? '比對中…' : '參數已變更，重新比對'}
          </button>
        ) : null}
        <span className="pt-compare-spacer" />
        <button title="下載比對圖（並排、疊合、特徵點）" onClick={() => void composeCompare(view, 'all', opacity).then((c) => downloadCanvas(c, `比對-${r.note || r.refId}.png`))}>
          下載
        </button>
        <button aria-label="關閉比對" title="回到 3D 檢視" onClick={() => studio.refs.closeCompare()}>
          ✕
        </button>
      </header>
      <div className="pt-compare-body">
        <div className="pt-compare-images">
          {mode === 'side' ? (
            <div className="pt-compare-fill pair">
              <img src={view.photo} alt="照片" />
              <img src={view.render} alt="人像（照片的相機）" />
            </div>
          ) : mode === 'overlay' ? (
            <div className="pt-compare-fill">
              <img src={view.photo} alt="照片" />
              <img src={view.render} alt="人像疊在照片上" style={{ opacity }} />
            </div>
          ) : landmarks ? (
            <div className="pt-compare-fill">
              <img src={landmarks} alt="特徵點：綠＝照片，紅＝人像；輪廓：藍＝照片，橘＝人像" />
            </div>
          ) : (
            <span className="muted pt-compare-wait">繪製中…</span>
          )}
        </div>
        <aside className="pt-compare-side">
          <div>
            特徵點誤差 <b>{r.error}%</b>
            {r.outline !== null ? (
              <>
                ・輪廓 <b>{r.outline}%</b>
              </>
            ) : null}
          </div>
          <div className="muted">（瞳距的百分比；越小越像）</div>
          <div className="muted">
            頭轉 {r.camera.yaw}°・俯仰 {r.camera.pitch}°・焦距約 {r.camera.focal35mm} mm・距離約 {Math.round(r.camera.distanceMm / 10)} cm
          </div>
          <h5>照片比人像</h5>
          <table className="pt-diff">
            <tbody>
              {worst.map((m) => (
                <tr key={m.key} className={Math.abs(m.diff) >= 8 ? 'big' : Math.abs(m.diff) >= 4 ? 'mid' : ''}>
                  <td>{m.label}</td>
                  <td className="pt-num">
                    {m.diff > 0 ? '+' : ''}
                    {m.diff}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">正值＝照片裡比較大、寬或長（同一個相機角度、以瞳距為準）。眼睛開合、唇厚也會受表情影響。</p>
          <h5>各部位誤差</h5>
          <div className="pt-regions">
            {Object.entries(r.regions).map(([k, v]) => (
              <span key={k}>
                {k} {v}%
              </span>
            ))}
          </div>
          <button className="primary" disabled={!!busy} title="只用這張照片自動擬合（可復原）" onClick={() => void runFit({ expression: 'estimate', refIds: [view.refId] })}>
            {busy === 'fit' ? '擬合中…' : '用這張照片自動擬合'}
          </button>
        </aside>
      </div>
    </div>
  );
}
