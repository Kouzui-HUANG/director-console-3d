import { useEffect, useRef, useState } from 'react';
import { studio } from '../app.ts';
import type { PortraitCommandCall } from '../core/commands.ts';
import { GROUPS, PARAMS } from '../core/params/registry.ts';
import { TRAITS } from '../core/params/traits.ts';
import { serializePortrait } from '../core/schema.ts';
import { setUI, useDoc, useUI } from './hooks.ts';

const SOURCE_LABEL = { ui: '介面', agent: 'AI', console: '主控台', system: '系統' } as const;

function parseInput(text: string): PortraitCommandCall[] {
  const raw = JSON.parse(text);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.commands)) return raw.commands;
  return [raw];
}

/** Text for pasting into a chat AI that cannot call tools. */
function aiPrompt(): string {
  const p = studio.doc.getState().portrait;
  const m = studio.ui.getState().measures;
  const groups = GROUPS.map((g) => `${g.label}：${PARAMS.filter((d) => d.group === g.id).map((d) => `${d.key}（${d.label}${d.neg ? `，${d.neg}↔${d.pos}` : ''}${d.unit ? `，${d.unit}` : ''}）`).join('、')}`).join('\n');
  return [
    '你是 3D 人像工作室的助手。請只回覆一個 JSON 陣列，每個元素是 {"cmd": "...", "args": {...}} 指令；我會貼回「指令主控台」執行。',
    '指令：portrait.set {params:{鍵:數值}}（null = 還原/自動）、portrait.reset {keys?, groups?}、portrait.applyPreset {preset, groups?}、portrait.applyTraits {traits:[...], amount?}、portrait.mix {sources:[{preset, weight}]}、portrait.update {name?, framing:{type: head|bust|half|full}}、portrait.neutralize、portrait.randomize {seed}。',
    '數值慣例：局部參數 −1～+1（0 不變，±1 約寫實極端，±2 為誇張上限）；體重、肌肉等巨集 −1～+1；性別 0（女）～1（男）；年齡用歲；body.heightCm 公分、body.headsTall 頭身比；姿勢用度，正值往人物自己的左邊、抬頭。',
    `預設：female-eastAsian、male-eastAsian、female-european、male-european、neutral。特徵詞：${TRAITS.map((t) => t.name).join('、')}。`,
    '',
    '參數：',
    groups,
    '',
    '目前的人像：',
    serializePortrait(p),
    m ? `\n量測（mm）：身高 ${m.height.toFixed(0)}、頭身比 ${m.headsTall.toFixed(2)}、臉寬 ${m.faceWidth.toFixed(0)}、瞳距 ${m.ipd.toFixed(1)}、眼裂寬 ${m.eyeWidth.toFixed(1)}、鼻翼寬 ${m.noseWidth.toFixed(1)}、嘴寬 ${m.mouthWidth.toFixed(1)}` : '',
  ].join('\n');
}

export function CommandConsole() {
  const open = useUI((s) => s.consoleOpen);
  const log = useDoc((s) => s.log);
  const [text, setText] = useState('[\n  {"cmd": "portrait.applyTraits", "args": {"traits": ["鵝蛋臉", "杏眼"], "amount": 0.8}},\n  {"cmd": "portrait.set", "args": {"params": {"face.nose.bridgeHeight": 0.3}}}\n]');
  const [dry, setDry] = useState(false);
  const [out, setOut] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [log.length, open]);
  if (!open) return null;
  const run = () => {
    let calls: PortraitCommandCall[];
    try {
      calls = parseInput(text);
    } catch (e) {
      setOut(`JSON 格式錯誤：${(e as Error).message}`);
      return;
    }
    const r = studio.runAs('console', calls, { dryRun: dry });
    if (r.ok) {
      setOut(`✅ 成功${dry ? '（試跑，未套用）' : ''}\n${JSON.stringify({ results: r.results, warnings: r.warnings }, null, 2)}`);
      return;
    }
    const lines = r.errors.map((e) => `❌ ${e.index >= 0 ? `第 ${e.index} 個指令` : '整批'}失敗：${e.message}${e.hint ? `\n   提示：${e.hint}` : ''}`);
    setOut(`${r.errors.length > 1 ? `共 ${r.errors.length} 個錯誤，整批未套用。\n` : ''}${lines.join('\n')}`);
  };
  return (
    <aside className="console pt-console" aria-label="指令主控台">
      <header>
        <b>指令主控台</b>
        <span className="muted">每個操作都是一個 JSON 指令；AI 與介面共用。</span>
        <span className="spacer" />
        <button
          className="mini"
          onClick={() => {
            void navigator.clipboard?.writeText(aiPrompt());
            studio.toast('已複製給 AI 的說明與目前人像，可貼到任何聊天 AI', 'success');
          }}
        >
          複製給 AI 的說明
        </button>
        <button className="icon-btn" aria-label="關閉主控台" onClick={() => setUI({ consoleOpen: false })}>
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
        {log.length === 0 && <p className="hint pad">操作介面時，這裡會顯示對應的指令（拖滑桿的細步驟不列出）。</p>}
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
