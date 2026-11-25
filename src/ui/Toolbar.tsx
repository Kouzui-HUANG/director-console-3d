import { app } from '../app/app.ts';
import { undo, redo } from '../core/store.ts';
import type { GizmoMode, ViewMode } from '../render/viewport.ts';
import { useDirector, useUI } from './hooks.ts';

const VIEWS: [ViewMode, string, string][] = [
  ['editor', '編輯', '1'],
  ['top', '俯視', '2'],
  ['camera', '攝影機', '3'],
  ['program', '節目', '4'],
  ['multiview', '多機位', '5'],
];
const GIZMOS: [GizmoMode, string, string][] = [
  ['translate', '移動', 'W'],
  ['rotate', '旋轉', 'E'],
  ['scale', '縮放', 'R'],
];

export function Toolbar() {
  const name = useDirector((s) => s.project.name);
  const canUndo = useDirector((s) => s.past.length > 0);
  const canRedo = useDirector((s) => s.future.length > 0);
  const undoLabel = useDirector((s) => s.past[s.past.length - 1]?.label);
  const dirty = useDirector((s) => s.rev !== s.savedRev);
  const saving = useUI((s) => s.saving);
  const view = useUI((s) => s.viewMode);
  const gizmo = useUI((s) => s.gizmoMode);
  const server = useUI((s) => s.server);
  const consoleOpen = useUI((s) => s.consoleOpen);
  const status = saving === 'error' ? '儲存失敗' : dirty || saving === 'saving' ? '儲存中…' : '已儲存';
  return (
    <header className="toolbar" role="toolbar" aria-label="工具列">
      <div className="brand">🎬 3D 導演台</div>
      <button className="project-btn" aria-label="專案管理" title="專案管理（開啟、新增、匯入/匯出）" onClick={() => app.openDialog('projects')}>
        <span className="pname">{name}</span> ▾
      </button>
      <span className={`save-state ${saving === 'error' ? 'err' : dirty ? 'dirty' : ''}`} title={app.storage.label}>
        {status}
      </span>
      <div className="sep" />
      <button aria-label="復原" title={`復原${undoLabel ? `：${undoLabel}` : ''} (⌘Z)`} disabled={!canUndo} onClick={() => undo(app.store)}>
        ↶
      </button>
      <button aria-label="重做" title="重做 (⇧⌘Z)" disabled={!canRedo} onClick={() => redo(app.store)}>
        ↷
      </button>
      <div className="sep" />
      <div className="segmented" role="group" aria-label="操控模式">
        {GIZMOS.map(([m, label, key]) => (
          <button key={m} className={gizmo === m ? 'on' : ''} aria-pressed={gizmo === m} title={`${label} (${key})`} onClick={() => app.ui.setState({ gizmoMode: m })}>
            {label}
          </button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="視角">
        {VIEWS.map(([m, label, key]) => (
          <button key={m} className={view === m ? 'on' : ''} aria-pressed={view === m} title={`${label} (${key})`} onClick={() => app.setView(m)}>
            {label}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <button aria-label="匯出影片與圖片" className="primary" title="輸出 MP4、截圖、分鏡表 (⌘E)" onClick={() => app.openDialog('export')}>
        ⬇ 輸出
      </button>
      <button aria-label="指令主控台" className={consoleOpen ? 'on' : ''} title="指令主控台：查看與執行 JSON 指令 (⌘K)" onClick={() => app.ui.setState({ consoleOpen: !consoleOpen })}>
        {'{ }'} 指令
      </button>
      <a className="entry-link" href="/portrait" target="_blank" rel="noopener" aria-label="人像工作室" title="人像工作室：用參數做寫實的人像白模（開新分頁）">
        🗿 人像
      </a>
      <button aria-label="效能與顯示設定" title="效能與顯示設定" onClick={() => app.openDialog('settings')}>
        ⚙
      </button>
      <button aria-label="說明" title="說明與快捷鍵 (?)" onClick={() => app.openDialog('help')}>
        ?
      </button>
      <span className={`server-pill ${server.bridge ? 'on' : server.connected ? 'half' : ''}`} title={server.connected ? `本機伺服器：${server.root ?? ''}（AI 可透過 MCP 操作）` : '瀏覽器模式：專案存在瀏覽器中。執行 npm start 可啟用本機伺服器與 AI（MCP）'}>
        {server.bridge ? 'AI 連線中' : server.connected ? '本機伺服器' : '瀏覽器模式'}
      </span>
    </header>
  );
}
