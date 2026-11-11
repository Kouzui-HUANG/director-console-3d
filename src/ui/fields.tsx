import { useEffect, useRef, useState, type ReactNode } from 'react';
import { app } from '../app/app.ts';
import type { Field, ListField, ScalarField } from '../core/fields.ts';
import { listItemDefaults } from '../core/fields.ts';
import { sameFrame } from '../core/interpolate.ts';
import type { Vec3 } from '../core/math.ts';
import type { SceneObject } from '../core/schema.ts';

let editSeq = 0;
/** One undo step per continuous edit gesture (drag-scrub, slider). */
export function newEditKey(prefix: string): string {
  return `${prefix}:${++editSeq}`;
}

function fmt(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '';
  const s = v.toFixed(precision);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function NumberField(props: {
  value: number;
  onChange: (v: number, gestureKey?: string) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  label?: ReactNode;
  precision?: number;
  title?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const { value, onChange, step = 0.1, min = -Infinity, max = Infinity, unit, label, precision = 3, title, ariaLabel } = props;
  const [text, setText] = useState(fmt(value, precision));
  const [focused, setFocused] = useState(false);
  const drag = useRef<{ x: number; v: number; key: string; moved: boolean } | null>(null);
  useEffect(() => {
    if (!focused) setText(fmt(value, precision));
  }, [value, focused, precision]);
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (Number.isFinite(v) && v !== value) onChange(clampV(v));
    else setText(fmt(value, precision));
  };
  return (
    <label className={`num ${props.className ?? ''}`} title={title}>
      {label !== undefined && (
        <span
          className="num-label"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, v: value, key: newEditKey('scrub'), moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            if (Math.abs(dx) > 1) d.moved = true;
            const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const v = clampV(Math.round((d.v + dx * step * k * 0.5) / step) * step);
            if (d.moved) onChange(Number(v.toFixed(6)), d.key);
          }}
          onPointerUp={() => (drag.current = null)}
        >
          {label}
        </span>
      )}
      <input
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        value={text}
        inputMode="decimal"
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(fmt(value, precision));
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const k = e.shiftKey ? 10 : 1;
            const v = clampV(value + (e.key === 'ArrowUp' ? step : -step) * k);
            onChange(Number(v.toFixed(6)));
            setText(fmt(v, precision));
          }
        }}
      />
      {unit && <span className="num-unit">{unit}</span>}
    </label>
  );
}

export function Vec3Field(props: { value: Vec3; onChange: (v: Vec3, key?: string) => void; step?: number; unit?: string; labels?: [string, string, string]; precision?: number; ariaLabel?: string }) {
  const { value, onChange, step = 0.1, labels = ['X', 'Y', 'Z'], precision = 3 } = props;
  return (
    <div className="vec3">
      {[0, 1, 2].map((i) => (
        <NumberField
          key={i}
          className={`axis-${i}`}
          label={labels[i]}
          ariaLabel={`${props.ariaLabel ?? ''} ${labels[i]}`}
          value={value[i]!}
          step={step}
          precision={precision}
          onChange={(v, k) => {
            const next = [...value] as Vec3;
            next[i] = v;
            onChange(next, k);
          }}
        />
      ))}
    </div>
  );
}

export function Row(props: { label: ReactNode; children: ReactNode; keyToggle?: ReactNode; hint?: string }) {
  return (
    <div className="row" title={props.hint}>
      <div className="row-label">
        {props.label}
        {props.keyToggle}
      </div>
      <div className="row-body">{props.children}</div>
    </div>
  );
}

export function Section(props: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section className={`section ${open ? 'open' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="section-title">{props.title}</span>
        <span className="section-right" onClick={(e) => e.stopPropagation()}>
          {props.right}
        </span>
      </header>
      {open && <div className="section-body">{props.children}</div>}
    </section>
  );
}

/** ◆ keyframe toggle for one property at the current time. */
export function KeyToggle(props: { obj: SceneObject; path: string; t: number }) {
  const { obj, path, t } = props;
  const fps = app.store.getState().project.settings.fps;
  const track = obj.tracks[path];
  const at = track?.keys.find((k) => sameFrame(k.t, t, fps));
  const state = at ? 'on' : track && track.keys.length ? 'animated' : 'off';
  return (
    <button
      className={`key-toggle ${state}`}
      aria-label={at ? `刪除 ${path} 在此時間的關鍵影格` : `在目前時間為 ${path} 加入關鍵影格`}
      title={at ? '刪除此關鍵影格' : state === 'animated' ? '已有動畫：在目前時間加入關鍵影格' : '加入關鍵影格（開始為此屬性做動畫）'}
      onClick={(e) => {
        e.stopPropagation();
        if (at) app.run({ cmd: 'key.remove', args: { id: obj.id, prop: path, t: at.t } });
        else app.run({ cmd: 'key.set', args: { id: obj.id, prop: path, t } });
      }}
    >
      {state === 'on' ? '◆' : '◇'}
    </button>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; ariaLabel?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" aria-label={props.ariaLabel ?? props.label} checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" />
      {props.label && <span>{props.label}</span>}
    </label>
  );
}

export function Select<T extends string>(props: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <select aria-label={props.ariaLabel} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
      {props.options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function ColorField(props: { value: string; onChange: (v: string) => void; ariaLabel?: string }) {
  return (
    <span className="color-field">
      <input type="color" aria-label={props.ariaLabel ?? '顏色'} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <code>{props.value}</code>
    </span>
  );
}

/** Auto-generated form for a type's params. */
export function ParamForm(props: {
  fields: readonly Field[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown, gestureKey?: string) => void;
  keyToggle?: (key: string) => ReactNode;
  showAdvanced?: boolean;
}) {
  return (
    <>
      {props.fields
        .filter((f) => props.showAdvanced || !f.advanced)
        .map((f) =>
          f.kind === 'list' ? (
            <ListEditor key={f.key} field={f} value={(props.values[f.key] as Record<string, unknown>[]) ?? []} onChange={(v) => props.onChange(f.key, v)} />
          ) : (
            <Row key={f.key} label={f.label} hint={f.hint} keyToggle={props.keyToggle?.(f.key)}>
              <ScalarInput field={f} value={props.values[f.key]} onChange={(v, k) => props.onChange(f.key, v, k)} />
            </Row>
          ),
        )}
    </>
  );
}

export function ScalarInput(props: { field: ScalarField; value: unknown; onChange: (v: unknown, gestureKey?: string) => void }) {
  const f = props.field;
  switch (f.kind) {
    case 'number':
      return (
        <NumberField
          ariaLabel={f.label}
          value={typeof props.value === 'number' ? props.value : f.default}
          step={f.step ?? (f.int ? 1 : 0.1)}
          min={f.min}
          max={f.max}
          unit={f.unit}
          precision={f.int ? 0 : 3}
          label="↔"
          onChange={(v, k) => props.onChange(f.int ? Math.round(v) : v, k)}
        />
      );
    case 'enum':
      return <Select ariaLabel={f.label} value={String(props.value ?? f.default)} options={f.options} onChange={(v) => props.onChange(v)} />;
    case 'bool':
      return <Toggle ariaLabel={f.label} checked={Boolean(props.value ?? f.default)} onChange={(v) => props.onChange(v)} />;
    case 'color':
      return <ColorField ariaLabel={f.label} value={String(props.value ?? f.default)} onChange={(v) => props.onChange(v)} />;
    case 'text':
      return <input aria-label={f.label} value={String(props.value ?? '')} onChange={(e) => props.onChange(e.target.value)} />;
  }
}

function ListEditor(props: { field: ListField; value: Record<string, unknown>[]; onChange: (v: Record<string, unknown>[]) => void }) {
  const { field, value } = props;
  return (
    <div className="list-editor">
      <div className="list-head">
        <span>{field.label}</span>
        <button className="mini" aria-label={`新增${field.label}`} onClick={() => props.onChange([...value, listItemDefaults(field)])}>
          ＋ 新增
        </button>
      </div>
      {field.hint && <div className="hint">{field.hint}</div>}
      {value.map((item, i) => (
        <div className="list-item" key={i}>
          <div className="list-item-head">
            <span>
              {field.label} {i + 1}
            </span>
            <button className="mini danger" aria-label={`刪除${field.label} ${i + 1}`} onClick={() => props.onChange(value.filter((_, j) => j !== i))}>
              刪除
            </button>
          </div>
          {field.item.map((sub) => (
            <Row key={sub.key} label={sub.label}>
              <ScalarInput
                field={sub}
                value={item[sub.key]}
                onChange={(v) => props.onChange(value.map((it, j) => (j === i ? { ...it, [sub.key]: v } : it)))}
              />
            </Row>
          ))}
        </div>
      ))}
    </div>
  );
}
