import { useEffect, useRef, useState } from 'react';
import { app } from '../app/app.ts';
import type { CommandCall } from '../core/commands/execute.ts';
import { describeSceneWithChecks } from '../core/checks.ts';
import { useDirector, useUI } from './hooks.ts';

const SOURCE_LABEL = { ui: '介面', agent: 'AI', console: '主控台', system: '系統' } as const;

function parseInput(text: string): CommandCall[] {
  const raw = JSON.parse(text);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.commands)) return raw.commands;
  return [raw];
}

/** Text for pasting into a chat AI that cannot call tools. */
function aiPrompt(): string {
  const s = app.store.getState();
  return [
    '你是 3D 導演台的助手。請只回覆一個 JSON 陣列，每個元素是 {"cmd": "...", "args": {...}} 指令；我會貼回導演台的「指令主控台」執行。',
    '規則：單位公尺/度/秒；Y 向上，+X 東、−Z 北；人物旋轉 0° 面向 +Z；Y 旋轉正值向左轉；攝影機旋轉 0 時朝 −Z 看。',
    '常用指令：object.add {type,id,position,rotation,params,camera}、object.update、object.moveTo {id,to,start,duration}、object.followPath、object.face、key.set {id,prop,t,v,ease}、camera.frame {camera,target,shot:ECU|CU|MCU|MS|MLS|FS|LS|ELS,angle,side,over}、camera.move {camera,preset,start,duration,amount}、cut.set {t,camera}、marker.set、project.update {settings:{duration,fps,aspect}}。',
    '物件類型：male female child passerby crowd ground hills water road wall room building house cityBlock stairs pillar box sphere cylinder cone plane table chair sofa bed desk door car tree bush streetLight bench camera target mark。',
    '',
    '目前場景：',
    describeSceneWithChecks(s.project, s.ui.time),
  ].join('\n');
}

export function CommandConsole() {
  const open = useUI((s) => s.consoleOpen);
  const log = useDirector((s) => s.log);
  const [text, setText] = useState('[\n  {"cmd": "object.add", "args": {"type": "female", "id": "lead", "position": [1, 0, 0]}}\n]');
  const [dry, setDry] = useState(false);
  const [out, setOut] = useState<string>('');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [log.length, open]);
  if (!open) return null;
  const run = () => {
    let calls: CommandCall[];
    try {
      calls = parseInput(text);
    } catch (e) {
      setOut(`JSON 格式錯誤：${(e as Error).message}`);
      return;
    }
    const r = app.runAs('console', calls, { dryRun: dry });
    if (r.ok) {
      setOut(`✅ 成功${dry ? '（試跑，未套用）' : ''}\n${JSON.stringify({ results: r.results, warnings: r.warnings }, null, 2)}`);
      return;
    }
    const errors = r.errors?.length ? r.errors : [r.error];
    const lines = errors.map((e) => `❌ ${e.index >= 0 ? `第 ${e.index} 個指令` : '整批'}失敗：${e.message}${e.hint ? `\n   提示：${e.hint}` : ''}`);
    setOut(`${errors.length > 1 ? `共 ${errors.length} 個錯誤，整批未套用。\n` : ''}${lines.join('\n')}`);
  };
  return (
    <aside className="console" aria-label="指令主控台">
      <header>
        <b>指令主控台</b>
        <span className="muted">每個操作都是一個 JSON 指令；AI 與介面共用。</span>
        <span className="spacer" />
        <button
          className="mini"
          onClick={() => {
            void navigator.clipboard?.writeText(aiPrompt());
            app.toast('已複製給 AI 的說明與目前場景，可貼到任何聊天 AI', 'success');
          }}
        >
          複製給 AI 的說明
        </button>
        <button className="icon-btn" aria-label="關閉主控台" onClick={() => app.ui.setState({ consoleOpen: false })}>
          ✕
        </button>
      </header>
      <div className="console-log" ref={listRef}>
        {log.map((e) => (
          <details key={e.id} className={e.ok ? '' : 'err'}>
            <summary>
              <span className="badge">{SOURCE_LABEL[e.source]}</span>
              <span className="muted">{new Date(e.at).toLocaleTimeString('zh-TW')}</span>
              <span>{e.calls.map((c) => c.cmd).join(', ')}</span>
              {!e.ok && <span className="err-text">✕ {e.error?.message}</span>}
            </summary>
            <pre>{JSON.stringify(e.calls, null, 2)}</pre>
            <button className="mini" onClick={() => setText(JSON.stringify(e.calls, null, 2))}>
              複製到輸入框
            </button>
          </details>
        ))}
        {log.length === 0 && <p className="hint pad">操作介面時，這裡會顯示對應的指令。</p>}
      </div>
      <textarea
        aria-label="指令輸入"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            run();
          }
        }}
      />
      <div className="console-actions">
        <label className="check">
          <input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> 試跑（不套用）
        </label>
        <span className="spacer" />
        <button className="primary" onClick={run}>
          執行（⌘↵）
        </button>
      </div>
      {out && <pre className="console-out">{out}</pre>}
    </aside>
  );
}

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
