import { useRef, useState } from 'react';
import { studio } from '../app.ts';
import { PRESETS } from '../core/params/presets.ts';
import { FRAMING_LABELS, type FramingType } from '../core/schema.ts';
import { setUI, useDoc, useUI } from './hooks.ts';

function Modal({ title, wide, children }: { title: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setUI({ dialog: null })}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <header>
          <h3>{title}</h3>
          <button className="icon-btn" aria-label="關閉" onClick={() => setUI({ dialog: null })}>
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function importFile(file: File) {
  void file.text().then((t) => studio.importJson(t));
}

function LibraryDialog() {
  const library = useUI((s) => s.library);
  const current = useDoc((s) => s.portrait);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('female-eastAsian');
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Modal title="人像" wide>
      <div className="pt-lib-actions">
        <label>
          名稱
          <input aria-label="新人像名稱" placeholder="未命名人像" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <select aria-label="新人像的預設" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              從「{p.label}」開始
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => void studio.createNew(preset, name || undefined)}>
          ＋ 新增人像
        </button>
        <span className="spacer" />
        <button onClick={() => void studio.duplicate()} title="把目前的人像另存一份">
          另存副本
        </button>
        <button onClick={() => fileRef.current?.click()}>匯入 .portrait.json</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        <button onClick={() => studio.exportJson()}>匯出目前人像</button>
      </div>
      <div className="pt-rename">
        <label>
          目前人像的名稱
          <input
            aria-label="目前人像的名稱"
            defaultValue={current.name}
            key={current.id}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== current.name && studio.run({ cmd: 'portrait.update', args: { name: e.target.value.trim() } })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </label>
        <span className="muted">存在：{studio.storage.label}</span>
      </div>
      <div className="pt-lib-grid">
        {library.map((m) => (
          <div key={m.id} className={`pt-lib-card${m.id === current.id ? ' current' : ''}`}>
            <button className="pt-lib-open" title={`開啟「${m.name}」`} onClick={() => void studio.openById(m.id)}>
              {m.thumbnail ? <img src={m.thumbnail} alt="" /> : <div className="pt-lib-empty">🗿</div>}
              <div className="pt-lib-name">{m.name}</div>
              <div className="muted">
                {FRAMING_LABELS[m.framing as FramingType] ?? m.framing}・{m.params} 個參數・{new Date(m.updatedAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </button>
            <button
              className="mini danger"
              aria-label={`刪除 ${m.name}`}
              title={studio.storage.kind === 'server' ? '刪除（移到 portraits/.trash/，可救回）' : '刪除'}
              onClick={() => {
                if (confirm(`刪除「${m.name}」？${studio.storage.kind === 'server' ? '（會移到 portraits/.trash/）' : '（瀏覽器模式無法救回）'}`)) void studio.remove(m.id);
              }}
            >
              刪除
            </button>
          </div>
        ))}
        {library.length === 0 ? <p className="hint">還沒有人像。</p> : null}
      </div>
    </Modal>
  );
}

function ExportDialog() {
  return (
    <Modal title="輸出">
      <h4>圖片</h4>
      <div className="pt-export-row">
        <button className="primary" title="頭肩取景，1920 × 1080" onClick={() => studio.exportTurnaround()}>
          三視圖 PNG（正面／半側／側面）
        </button>
        <button onClick={() => studio.exportSheet()}>依取景三角度 PNG</button>
        <button onClick={() => studio.exportSheet(['front', 'threeQuarterLeft', 'left', 'back', 'right', 'threeQuarterRight'], [600, 720])}>六視角 PNG</button>
      </div>
      <h4>人像檔</h4>
      <div className="pt-export-row">
        <button onClick={() => studio.exportJson()}>下載 .portrait.json（參數檔，可匯入或給 AI）</button>
      </div>
      <p className="hint">GLB／OBJ 網格檔在第 7 階段加入。</p>
    </Modal>
  );
}

function HelpDialog() {
  return (
    <Modal title="說明與快捷鍵">
      <p>人像工作室用 MakeHuman 的寫實底模（CC0）加上語意參數做白模人像。所有修改都是可復原的指令；AI 也用同一套指令。</p>
      <h4>快捷鍵</h4>
      <ul className="pt-keys">
        <li>
          <kbd>1</kbd>–<kbd>6</kbd> 視角（正面、左 3/4、左側、背面、右側、右 3/4）
        </li>
        <li>
          <kbd>T</kbd> 轉台　<kbd>F</kbd> 重設鏡頭
        </li>
        <li>
          <kbd>⌘Z</kbd> 復原　<kbd>⇧⌘Z</kbd> 重做　<kbd>⌘S</kbd> 立即儲存
        </li>
        <li>
          <kbd>⌘K</kbd> 指令主控台　<kbd>⌘E</kbd> 輸出
        </li>
      </ul>
      <h4>小技巧</h4>
      <ul>
        <li>滑鼠停在參數上，模型會用橘色標出受影響的區域。</li>
        <li>「誇張」打開後，滑桿延伸到誇張範圍（寫實範圍外的數值會變紅）。</li>
        <li>身高與頭身比預設「自動」；給定數值後，改性別或族群時仍會保持。</li>
        <li>把 .portrait.json 拖進視窗就能匯入。</li>
      </ul>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useUI((s) => s.dialog);
  if (dialog === 'library') return <LibraryDialog />;
  if (dialog === 'export') return <ExportDialog />;
  if (dialog === 'help') return <HelpDialog />;
  return null;
}
