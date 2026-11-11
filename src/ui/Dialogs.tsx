import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { app, type QualityLevel } from '../app/app.ts';
import { cameraObjects } from '../core/evaluate.ts';
import { RESOLUTION_TIERS, resolutionFor } from '../core/lens.ts';
import { TEMPLATES } from '../core/templates.ts';
import { downloadBlob, exportVideo, ExportCancelled, safeFilename, type ExportQuality } from '../export/mp4.ts';
import { renderStoryboard } from '../export/storyboard.ts';
import { outputSize } from '../render/offscreen.ts';
import { serverToken } from '../storage/stores.ts';
import { Toggle } from './fields.tsx';
import { useDirector, usePrefs, useUI } from './hooks.ts';

function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [props]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <header>
          <h3>{props.title}</h3>
          <button aria-label="關閉" className="icon-btn" onClick={props.onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function Dialogs() {
  const dialog = useUI((s) => s.dialog);
  const close = () => app.ui.setState({ dialog: null });
  if (dialog === 'projects') return <ProjectManager onClose={close} />;
  if (dialog === 'export') return <ExportDialog onClose={close} />;
  if (dialog === 'help') return <HelpDialog onClose={close} />;
  if (dialog === 'settings') return <SettingsDialog onClose={close} />;
  return null;
}

// ---------------------------------------------------------------------------

function ProjectManager({ onClose }: { onClose: () => void }) {
  const projects = useUI((s) => s.projects);
  const current = useDirector((s) => s.project.id);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Modal title="專案" onClose={onClose} wide>
      <div className="pm-section">
        <h4>新增專案</h4>
        <div className="pm-new">
          <input aria-label="新專案名稱" placeholder="新專案名稱（選填）" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className="template"
              onClick={async () => {
                await app.createProject(t.id, name || undefined);
                onClose();
              }}
            >
              <b>{t.label}</b>
              <span>{t.description}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="pm-section">
        <h4>
          我的專案 <span className="muted">（{app.storage.label}）</span>
        </h4>
        <div className="project-grid">
          {projects.map((p) => (
            <div key={p.id} className={`project-card ${p.id === current ? 'current' : ''}`}>
              <button
                className="thumb"
                aria-label={`開啟 ${p.name}`}
                onClick={async () => {
                  if (p.id !== current) await app.openById(p.id);
                  onClose();
                }}
              >
                {p.thumbnail ? <img src={p.thumbnail} alt="" /> : <span>🎬</span>}
              </button>
              <div className="pc-info">
                <b title={p.name}>{p.name}</b>
                <span className="muted">
                  {new Date(p.updatedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })} · {p.objects ?? 0} 物件 · {p.duration ?? '?'}s
                </span>
                <code className="muted">{p.id}</code>
              </div>
              <div className="pc-actions">
                {confirmDelete === p.id ? (
                  <>
                    <button
                      className="mini danger"
                      onClick={async () => {
                        await app.deleteProject(p.id);
                        setConfirmDelete(null);
                      }}
                    >
                      確定刪除
                    </button>
                    <button className="mini" onClick={() => setConfirmDelete(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button className="mini danger" aria-label={`刪除 ${p.name}`} onClick={() => setConfirmDelete(p.id)}>
                    刪除
                  </button>
                )}
              </div>
            </div>
          ))}
          {projects.length === 0 && <p className="hint">還沒有儲存的專案。</p>}
        </div>
      </div>
      <div className="button-row">
        <button onClick={() => void app.duplicateProject().then(onClose)}>複製目前專案</button>
        <button onClick={() => app.exportJson()}>匯出目前專案（.json）</button>
        <button onClick={() => fileRef.current?.click()}>匯入專案檔…</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f && (await app.importJson(await f.text()))) onClose();
            e.target.value = '';
          }}
        />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useDirector((s) => s.project);
  const job = useUI((s) => s.exportJob);
  const server = useUI((s) => s.server);
  const cams = cameraObjects(project);
  const [source, setSource] = useState('program');
  const [range, setRange] = useState<'all' | 'custom'>('all');
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(project.settings.duration);
  const [tier, setTier] = useState<string>('project');
  const [quality, setQuality] = useState<ExportQuality>('standard');
  const [burn, setBurn] = useState({ timecode: false, camera: false, lens: false, title: false });
  const [filename, setFilename] = useState(safeFilename(project.name));
  const [result, setResult] = useState<null | { url: string; name: string; info: string; saved?: string }>(null);
  const [error, setError] = useState<string | null>(null);
  const [rw, rh] = project.settings.resolution;
  const size = useMemo<[number, number]>(() => (tier === 'project' ? [rw, rh] : resolutionFor(rw / rh, RESOLUTION_TIERS.find((t) => t.key === tier)?.base ?? 1080)), [tier, rw, rh]);
  const s0 = range === 'all' ? 0 : Math.max(0, Math.min(start, project.settings.duration));
  const s1 = range === 'all' ? project.settings.duration : Math.max(s0 + 1 / project.settings.fps, Math.min(end, project.settings.duration));
  const frames = Math.round((s1 - s0) * project.settings.fps);
  const usesPanorama = cams.some((c) => c.camera?.lens === 'panorama');
  const webcodecs = typeof VideoEncoder !== 'undefined';

  const run = async () => {
    if (!app.shots) return;
    setError(null);
    setResult(null);
    const ctrl = new AbortController();
    app.ui.setState({ exportJob: { fraction: 0, frame: 0, total: frames, etaSec: 0, cancel: () => ctrl.abort() } });
    try {
      const r = await exportVideo(project, app.shots, {
        source,
        start: s0,
        end: s1,
        width: size[0],
        height: size[1],
        fps: project.settings.fps,
        quality,
        burnIn: burn,
        signal: ctrl.signal,
        onProgress: (p) => app.ui.setState({ exportJob: { fraction: p.fraction, frame: p.frame, total: p.total, etaSec: p.etaSec, cancel: () => ctrl.abort() } }),
      });
      const name = `${filename || 'director3d'}.${r.ext}`;
      let saved: string | undefined;
      if (server.connected && serverToken()) {
        try {
          const res = await fetch(`/api/exports?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': r.mime, 'x-director-token': serverToken()! }, body: r.blob });
          if (res.ok) saved = ((await res.json()) as { path: string }).path;
        } catch {
          /* download still works */
        }
      }
      const url = URL.createObjectURL(r.blob);
      setResult({ url, name, saved, info: `${r.width}×${r.height} · ${r.frames} 格 · ${r.duration.toFixed(2)} 秒 · ${r.codec.toUpperCase()} · ${(r.blob.size / 1024 / 1024).toFixed(2)} MB · 用時 ${r.seconds.toFixed(1)} 秒` });
      downloadBlob(r.blob, name);
    } catch (e) {
      if (!(e instanceof ExportCancelled)) setError((e as Error).message);
    } finally {
      app.ui.setState({ exportJob: null });
    }
  };

  const still = (kind: 'png' | 'storyboard') => {
    if (!app.shots) return;
    if (kind === 'png') {
      const [w, h] = outputSize(project);
      const { canvas } = app.shots.render(project, app.store.getState().ui.time, source, w, h, 'export');
      canvas.toBlob((b) => b && downloadBlob(b, `${filename}_${app.store.getState().ui.time.toFixed(2)}s.png`), 'image/png');
      app.shots.restore();
    } else {
      const canvas = renderStoryboard(project, app.shots, { camera: source });
      canvas.toBlob((b) => b && downloadBlob(b, `${filename}_分鏡表.png`), 'image/png');
    }
  };

  return (
    <Modal title="輸出" onClose={() => !job && onClose()}>
      {!webcodecs && <p className="warn">這個瀏覽器不支援 WebCodecs，無法輸出影片，請使用最新版 Chrome。</p>}
      <div className="form-grid">
        <label>來源</label>
        <select aria-label="輸出來源" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="program">剪輯軌（依剪輯點切換機位）</option>
          {cams.map((c) => (
            <option key={c.id} value={c.id}>
              只用 {c.name || c.id}
            </option>
          ))}
        </select>
        <label>範圍</label>
        <div className="inline">
          <select aria-label="輸出範圍" value={range} onChange={(e) => setRange(e.target.value as 'all' | 'custom')}>
            <option value="all">全片（{project.settings.duration} 秒）</option>
            <option value="custom">自訂</option>
          </select>
          {range === 'custom' && (
            <>
              <input aria-label="開始秒數" type="number" step={0.1} value={start} onChange={(e) => setStart(Number(e.target.value))} /> –
              <input aria-label="結束秒數" type="number" step={0.1} value={end} onChange={(e) => setEnd(Number(e.target.value))} /> 秒
            </>
          )}
        </div>
        <label>解析度</label>
        <div className="inline">
          <select aria-label="輸出解析度" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="project">專案設定</option>
            {RESOLUTION_TIERS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="muted">
            {size[0]}×{size[1]} · {project.settings.fps}fps · {frames} 格
          </span>
        </div>
        <label>品質</label>
        <select aria-label="輸出品質" value={quality} onChange={(e) => setQuality(e.target.value as ExportQuality)}>
          <option value="draft">草稿（檔案小）</option>
          <option value="standard">標準</option>
          <option value="high">高</option>
        </select>
        <label>壓字</label>
        <div className="inline wrap">
          <Toggle label="時間碼" checked={burn.timecode} onChange={(v) => setBurn({ ...burn, timecode: v })} />
          <Toggle label="機位名稱" checked={burn.camera} onChange={(v) => setBurn({ ...burn, camera: v })} />
          <Toggle label="焦距" checked={burn.lens} onChange={(v) => setBurn({ ...burn, lens: v })} />
          <Toggle label="片名" checked={burn.title} onChange={(v) => setBurn({ ...burn, title: v })} />
        </div>
        <label>檔名</label>
        <input aria-label="檔名" value={filename} onChange={(e) => setFilename(e.target.value)} />
      </div>
      {usesPanorama && <p className="hint">含 360° 全景機位：輸出的是等距柱狀投影影片；若要讓 YouTube/VR 播放器辨識為 360°，需另以工具注入球面中繼資料。</p>}
      <p className="hint">逐格離線算圖：電腦較慢只會讓輸出久一點，影片本身不會掉格。輸出時請保持此分頁開啟。</p>
      {job ? (
        <div className="progress">
          <div className="bar">
            <div style={{ width: `${(job.fraction * 100).toFixed(1)}%` }} />
          </div>
          <span>
            {job.frame}/{job.total} 格 · 剩餘約 {Math.ceil(job.etaSec)} 秒
          </span>
          <button className="danger" onClick={() => job.cancel()}>
            取消
          </button>
        </div>
      ) : (
        <div className="button-row">
          <button className="primary" disabled={!webcodecs} onClick={() => void run()}>
            輸出影片（MP4）
          </button>
          <button onClick={() => still('png')}>目前畫面 PNG</button>
          <button onClick={() => still('storyboard')}>分鏡表 PNG</button>
        </div>
      )}
      {error && <p className="warn">輸出失敗：{error}</p>}
      {result && (
        <div className="result">
          ✅ 完成：
          <a href={result.url} download={result.name}>
            {result.name}
          </a>
          <div className="muted">{result.info}</div>
          {result.saved && <div className="muted">已存到 {result.saved}</div>}
          <video src={result.url} controls muted playsInline />
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

const SHORTCUTS: [string, string][] = [
  ['Space', '播放 / 暫停'],
  ['← / →', '前後一格（Shift：跳到上/下一個關鍵影格）'],
  ['Home / End', '跳到開頭 / 結尾'],
  ['W / E / R', '移動 / 旋轉 / 縮放'],
  ['按住 Shift 拖曳', '吸附（0.25m / 15°）'],
  ['K', '為選取物件加關鍵影格'],
  ['1 – 5', '編輯 / 俯視 / 攝影機 / 節目 / 多機位'],
  ['C', '看穿選取的攝影機'],
  ['F', '聚焦選取物件'],
  ['Delete', '刪除選取物件'],
  ['⌘/Ctrl + D', '複製'],
  ['⌘/Ctrl + Z / ⇧⌘Z', '復原 / 重做'],
  ['⌘/Ctrl + S', '立即儲存'],
  ['⌘/Ctrl + E', '輸出'],
  ['⌘/Ctrl + K', '指令主控台'],
  ['Esc', '取消選取 / 關閉視窗'],
];

function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="說明" onClose={onClose} wide>
      <div className="help-cols">
        <div>
          <h4>快速上手</h4>
          <ol>
            <li>從左側「物件庫」點選或拖曳人物、建築、道具到場景。</li>
            <li>選取物件後用移動/旋轉操控器調整，或在右側屬性面板輸入數值。</li>
            <li>做動畫：把時間指針移到某一秒，按屬性旁的 ◇ 或開啟「● 自動關鍵影格」再拖動物件。</li>
            <li>攝影機：新增攝影機（會放在目前編輯視角），用「一鍵構圖」快速取景，或套用「運鏡預設」。</li>
            <li>多機位：在時間軸「剪輯」列按 ＋，或到「多機位」監看牆點選機位切換。</li>
            <li>「⬇ 輸出」可輸出 MP4、目前畫面或分鏡表。</li>
          </ol>
          <h4>AI 操作</h4>
          <p>
            所有操作都是 JSON 指令（右上「{'{ }'} 指令」可看到每個操作對應的指令）。AI 可透過：MCP 工具（執行 <code>npm start</code> 後於 Claude Code 使用 <code>director3d</code>）、HTTP <code>/api/rpc</code>、網頁內的 <code>window.director</code>，或直接編輯 <code>projects/*.json</code>。詳見專案中的 <code>AGENTS.md</code>。
          </p>
        </div>
        <div>
          <h4>快捷鍵</h4>
          <table className="shortcuts">
            <tbody>
              {SHORTCUTS.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>座標</h4>
          <p className="hint">Y 軸向上，+X 為東、−Z 為北。人物旋轉 0° 時面向 +Z（朝向預設攝影機）；Y 旋轉正值為向左轉。單位：公尺、度、秒。</p>
        </div>
      </div>
    </Modal>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs((s) => s);
  const set = (p: Partial<typeof prefs>) => app.prefs.setState(p);
  const stats = app.viewport?.stats();
  return (
    <Modal title="效能與顯示" onClose={onClose}>
      <div className="form-grid">
        <label>畫質</label>
        <select aria-label="預覽畫質" value={prefs.quality} onChange={(e) => set({ quality: e.target.value as QualityLevel })}>
          <option value="low">省電（低階電腦）</option>
          <option value="medium">標準</option>
          <option value="high">高畫質</option>
        </select>
        <label>節目子母畫面</label>
        <Toggle checked={prefs.pip} onChange={(v) => set({ pip: v })} />
        <label>地面格線</label>
        <Toggle checked={prefs.grid} onChange={(v) => set({ grid: v })} />
        <label>預覽陰影</label>
        <Toggle checked={prefs.previewShadows} onChange={(v) => set({ previewShadows: v })} />
        <label>三分線</label>
        <Toggle checked={prefs.guides.thirds} onChange={(v) => set({ guides: { ...prefs.guides, thirds: v } })} />
        <label>安全框</label>
        <Toggle checked={prefs.guides.safe} onChange={(v) => set({ guides: { ...prefs.guides, safe: v } })} />
        <label>中心十字</label>
        <Toggle checked={prefs.guides.center} onChange={(v) => set({ guides: { ...prefs.guides, center: v } })} />
        <label>資訊列</label>
        <Toggle checked={prefs.guides.hud} onChange={(v) => set({ guides: { ...prefs.guides, hud: v } })} />
      </div>
      {stats && (
        <p className="hint">
          目前繪製：{stats.calls} 次繪製呼叫 · {stats.triangles.toLocaleString()} 三角面 · {stats.geometries} 幾何體
        </p>
      )}
      <p className="hint">預覽畫質只影響編輯時的畫面；輸出影片永遠以完整品質逐格算圖。</p>
    </Modal>
  );
}
