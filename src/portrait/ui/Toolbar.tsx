import { QUALITY, studio, type Quality } from '../app.ts';
import { FRAMINGS, FRAMING_LABELS } from '../core/schema.ts';
import { undo, redo } from '../core/store.ts';
import { setUI, useDoc, useUI } from './hooks.ts';

export function Toolbar() {
  const name = useDoc((s) => s.portrait.name);
  const framing = useDoc((s) => s.portrait.framing.type);
  const canUndo = useDoc((s) => s.past.length > 0);
  const canRedo = useDoc((s) => s.future.length > 0);
  const undoLabel = useDoc((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useDoc((s) => s.future[s.future.length - 1]?.label);
  const dirty = useDoc((s) => s.rev !== s.savedRev);
  const saving = useUI((s) => s.saving);
  const quality = useUI((s) => s.quality);
  const pupils = useUI((s) => s.pupils);
  const server = useUI((s) => s.server);
  const consoleOpen = useUI((s) => s.consoleOpen);
  const status = saving === 'error' ? '儲存失敗' : dirty || saving === 'saving' ? '儲存中…' : '已儲存';
  return (
    <header className="pt-toolbar" role="toolbar" aria-label="工具列">
      <div className="brand">🗿 人像工作室</div>
      <button className="project-btn" aria-label="人像管理" title="人像管理（新增、開啟、另存、匯入、匯出）" onClick={() => studio.openDialog('library')}>
        <span className="pname">{name}</span> ▾
      </button>
      <span className={`save-state ${saving === 'error' ? 'err' : dirty ? 'dirty' : ''}`} title={studio.storage.label}>
        {status}
      </span>
      <div className="sep" />
      <button aria-label="復原" title={`復原${undoLabel ? `：${undoLabel}` : ''} (⌘Z)`} disabled={!canUndo} onClick={() => undo(studio.doc)}>
        ↶
      </button>
      <button aria-label="重做" title={`重做${redoLabel ? `：${redoLabel}` : ''} (⇧⌘Z)`} disabled={!canRedo} onClick={() => redo(studio.doc)}>
        ↷
      </button>
      <div className="sep" />
      <div className="segmented" role="group" aria-label="構圖">
        {FRAMINGS.map((f) => (
          <button key={f} className={framing === f ? 'on' : ''} aria-pressed={framing === f} onClick={() => studio.setFraming(f)}>
            {FRAMING_LABELS[f]}
          </button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="網格品質">
        {(Object.keys(QUALITY) as Quality[]).map((q) => (
          <button key={q} className={quality === q ? 'on' : ''} aria-pressed={quality === q} aria-label={`品質：${QUALITY[q].label}`} title={`細分 ${QUALITY[q].level} 級`} onClick={() => setUI({ quality: q })}>
            {QUALITY[q].label}
          </button>
        ))}
      </div>
      <button className={pupils ? 'on' : ''} aria-pressed={pupils} aria-label="瞳孔" title="刻出虹膜與瞳孔（古典胸像的做法）" onClick={() => setUI({ pupils: !pupils })}>
        瞳孔
      </button>
      <span className="spacer" />
      <button className="primary" aria-label="輸出" title="輸出 PNG 多角度圖、人像檔 (⌘E)" onClick={() => studio.openDialog('export')}>
        ⬇ 輸出
      </button>
      <button aria-label="指令主控台" className={consoleOpen ? 'on' : ''} title="指令主控台：查看與執行 JSON 指令 (⌘K)" onClick={() => setUI({ consoleOpen: !consoleOpen })}>
        {'{ }'} 指令
      </button>
      <button aria-label="說明" title="說明與快捷鍵 (?)" onClick={() => studio.openDialog('help')}>
        ?
      </button>
      <span className={`server-pill ${server.bridge ? 'on' : server.connected ? 'half' : ''}`} title={server.connected ? `本機伺服器：${server.root ?? ''}（人像存在 portraits/）` : '瀏覽器模式：人像存在瀏覽器中（npm start 可改存到 portraits/ 資料夾）'}>
        {server.bridge ? '已連線' : server.connected ? '本機伺服器' : '瀏覽器模式'}
      </span>
      <a className="pt-link" href="/" title="回到 3D 導演台">
        ← 導演台
      </a>
    </header>
  );
}
