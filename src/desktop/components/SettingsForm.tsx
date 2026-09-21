import * as React from 'react';
import { createAvatar } from '../avatar.js';
import { desktopCommand, isDesktop } from '../host.js';
import { agents, loadListening, saveListening } from '../listening.js';
import { defaultPreferences, loadPreferences, savePreferences } from '../preferences.js';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/types/commands.js';
import type { AvatarStyle, RailPreferencesState, SourceConfig, SourceId } from '@/types/settings.js';

const counts = Array.from({length: 14}, (_, index) => index + 3);

const styles: readonly (readonly [AvatarStyle, string, string])[] = [
  ['animal', '小动物', '10 种动物伙伴'],
  ['bot', '几何伙伴', '3 种简洁造型'],
];

const allEnabled = () => Object.fromEntries(agents.map(([id]) => [id, true])) as Record<SourceId, boolean>;

const enabledOf = (sources: Record<SourceId, SourceConfig>) =>
  Object.fromEntries(agents.map(([id]) => [id, sources[id]?.enabled !== false])) as Record<SourceId, boolean>;

type Values = RailPreferencesState & { enabled: Record<SourceId, boolean> };

/**
 * Rendered while the first read is in flight. The pre-migration page shipped the
 * same shape as static markup — including the supported-looking autostart hint,
 * which only becomes "请在独立桌面应用中设置" once a read has confirmed it.
 */
const initialEnabled = allEnabled();
const initialValues: Values = {...defaultPreferences(), animation: false, autostart: false, autostartSupported: true, enabled: initialEnabled};

/**
 * Reproduces the old `.styles button` rules, including the 1px inset that the
 * pressed state applies so the card does not resize when its border thickens.
 */
// These are plain <button>s, not the shared Button, so they carry the focus ring
// themselves. Without it they fall back to the UA's own `outline: auto`, which is
// the browser's blue ring rather than the design's 2px #477d66.
const styleCard = [
  'cursor-pointer rounded-lg border border-line bg-secondary px-2 py-[14px] text-center text-inherit',
  'transition-colors hover:border-soft hover:bg-accent',
  'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring',
  'aria-pressed:border-2 aria-pressed:border-pressed aria-pressed:bg-muted aria-pressed:px-[7px] aria-pressed:py-[13px]',
].join(' ');

/** `avatar.js` builds its SVG imperatively, so the previews are appended by hand. */
function StylePreview({ style }: { style: AvatarStyle }) {
  const host = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    const element = host.current;
    if (!element) return;
    for (let slot = 0; slot < 3; slot++) element.append(createAvatar(style, slot) as Element);
    return () => element.replaceChildren();
  }, [style]);

  return <span ref={host} className="portraits" />;
}

interface ToggleRowProps {
  title: string;
  hint: string;
  hintId?: string;
  checked: boolean;
  disabled?: boolean;
  field: string;
  onChange: (checked: boolean) => void;
}

/**
 * The whole row is the label, as it was before the migration, so the gap between
 * the text and the switch stays clickable. A label wrapping a button forwards its
 * activation to it, and a click that lands on the button itself is not forwarded
 * again, so the switch never toggles twice.
 */
function ToggleRow({title, hint, hintId, checked, disabled, field, onChange}: ToggleRowProps) {
  return (
    <Label className="row">
      <span>
        <strong>{title}</strong>
        <small id={hintId}>{hint}</small>
      </span>
      <Switch data-field={field} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Label>
  );
}

export function SettingsForm() {
  const [values, setValues] = React.useState<Values>(initialValues);
  const [baseline, setBaseline] = React.useState<Record<SourceId, boolean>>(initialEnabled);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState('正在读取设置…');
  // Guards that must hold synchronously, before React re-renders: a second read
  // started in the same task, and a second submit in the same task.
  const readId = React.useRef(0);
  const saving = React.useRef(false);

  const edit = React.useCallback((change: (current: Values) => Partial<Values>) => {
    setValues(current => ({...current, ...change(current)}));
    setStatus('有未保存的更改');
  }, []);

  const load = React.useCallback(async () => {
    const id = ++readId.current;
    setStatus('正在读取设置…');
    try {
      const [preferences, sources] = await Promise.all([loadPreferences(), loadListening()]);
      if (id !== readId.current) return;
      const enabled = enabledOf(sources);
      setBaseline(enabled);
      setValues({...preferences, enabled});
      setReady(true);
      setFailed(false);
      setStatus('设置保存在本机');
    } catch (error) {
      if (id !== readId.current) return;
      setReady(false);
      setFailed(true);
      setStatus(`读取失败：${errorMessage(error)}`);
    }
  }, []);

  React.useEffect(() => { load().catch(() => {}); }, [load]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && isDesktop()) desktopCommand('close_settings').catch(() => {});
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setStatus('正在保存…');
    try {
      const changes = Object.fromEntries(agents.filter(([id]) => values.enabled[id] !== baseline[id]).map(([id]) => [id, values.enabled[id]]));
      if (Object.keys(changes).length) {
        const enabled = enabledOf(await saveListening(changes));
        setBaseline(enabled);
        setValues(current => ({...current, enabled}));
      }
      const preferences = await savePreferences({avatarStyle: values.avatarStyle, visibleCount: values.visibleCount, animation: values.animation, autostart: values.autostart});
      setValues(current => ({...current, ...preferences}));
      setStatus('已保存');
    } catch (error) {
      // The source write may already have landed; never report a full success here.
      setStatus(`部分设置可能已保存，请重试：${errorMessage(error)}`);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <main className="rail-settings">
      <header>
        <span className="eyebrow">AGENT COMPANION</span>
        <h1>悬浮窗设置</h1>
        <p>让桌面上的小伙伴，按你的习惯陪伴。</p>
      </header>
      <form onSubmit={submit}>
        <fieldset disabled={!ready || busy}>
          <section aria-labelledby="appearance">
            <h2 id="appearance">小伙伴的模样</h2>
            <div className="styles" role="group" aria-label="头像风格">
              {styles.map(([style, title, hint]) => (
                <button
                  key={style}
                  type="button"
                  data-style={style}
                  aria-pressed={values.avatarStyle === style}
                  className={styleCard}
                  onClick={() => edit(() => ({avatarStyle: style}))}
                >
                  <StylePreview style={style} />
                  <strong>{title}</strong>
                  <small>{hint}</small>
                </button>
              ))}
            </div>
            <ToggleRow
              field="animation"
              title="头像动画"
              hint="眨眼、转头与轻轻摇摆"
              checked={values.animation}
              onChange={animation => edit(() => ({animation}))}
            />
            <Label className="row">
              <span>
                <strong>默认显示数量</strong>
                <small>更多会话收起在展开按钮中</small>
              </span>
              <NativeSelect
                data-field="visibleCount"
                aria-label="默认显示数量"
                value={values.visibleCount}
                onChange={event => edit(() => ({visibleCount: Number(event.target.value)}))}
              >
                {counts.map(count => <option key={count} value={count}>{count} 个</option>)}
              </NativeSelect>
            </Label>
          </section>
          <section>
            <h2>Agent 监听</h2>
            <p className="section-hint">选择需要监听的 Agent，会话状态会显示在悬浮窗中。</p>
            {agents.map(([id, name]) => (
              <Label className="row agent-row" key={id}>
                <span className="agent-name">
                  <img src={`/icons/agents/${id}.png`} alt="" />
                  <strong>{name}</strong>
                </span>
                <Switch
                  data-field={`source-${id}`}
                  aria-label={`监听 ${name}`}
                  checked={values.enabled[id]}
                  onCheckedChange={enabled => edit(current => ({enabled: {...current.enabled, [id]: enabled}}))}
                />
              </Label>
            ))}
          </section>
          <section>
            <h2>启动</h2>
            <ToggleRow
              field="autostart"
              title="开机自启"
              hint={values.autostartSupported ? '登录电脑后自动显示悬浮窗' : '请在独立桌面应用中设置'}
              hintId="login-hint"
              checked={values.autostart}
              disabled={!values.autostartSupported}
              onChange={autostart => edit(() => ({autostart}))}
            />
          </section>
          <footer>
            <p role="status" id="save-status">{status}</p>
            <Button type="submit" data-action="save">保存更改</Button>
          </footer>
        </fieldset>
      </form>
      {failed && (
        <Button type="button" variant="outline" data-action="retry" onClick={() => { load().catch(() => {}); }}>重新读取</Button>
      )}
    </main>
  );
}
