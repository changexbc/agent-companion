import * as React from 'react';
import { Button } from '@/components/ui/button';
import { requestIntegrations } from '../integrations.js';
import { agents } from '../listening.js';
import { errorMessage } from '@/types/commands.js';
import type { IntegrationAction, IntegrationStatus } from '@/types/integrations.js';

const labels: Record<IntegrationStatus['status'], string> = {
  installed: '已接入', not_installed: '未接入', partial: '需要修复',
  error: '接入失败', unavailable: '暂不可用', pending: '待处理',
};

export function IntegrationManager({disabled, acquire, release}: {
  disabled: boolean; acquire: () => boolean; release: () => void;
}) {
  const [sources, setSources] = React.useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [active, setActive] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState('');
  const mounted = React.useRef(false);
  const running = React.useRef(false);

  React.useEffect(() => {
    mounted.current = true;
    requestIntegrations().then(value => { if (mounted.current) setSources(value.sources); })
      .catch(error => { if (mounted.current) setMessage(errorMessage(error)); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, []);

  async function run(action?: IntegrationAction) {
    if (running.current || !acquire()) return;
    running.current = true;
    setActive(action ? `${action.source}-${action.action}` : 'refresh');
    setMessage('');
    try {
      const value = await requestIntegrations(action);
      if (mounted.current) {
        setSources(value.sources);
        const item = action && value.sources.find(item => item.source === action.source);
        setMessage(item ? item.message : '状态已刷新');
      }
    } catch (error) {
      // A partial mutation may already be durable. Re-read without claiming success.
      const failure = errorMessage(error);
      if (action) {
        try { const value = await requestIntegrations(); if (mounted.current) setSources(value.sources); } catch { /* retain last known snapshot */ }
      }
      if (mounted.current) setMessage(`操作失败：${failure}`);
    } finally {
      running.current = false;
      release();
      if (mounted.current) setActive(null);
    }
  }

  return <div className="integration-manager" aria-label="接入管理" aria-busy={loading || active !== null}>
    <div className="integration-heading">
      <h3>Hooks 与 Webhook</h3>
      <Button type="button" variant="outline" disabled={disabled || loading || active !== null} onClick={() => void run()}>刷新状态</Button>
    </div>
    <p className="section-hint">接入操作立即生效，卸载后不会自动安装。关闭监听会保留 Hooks；Codeg 会注销 Webhook。</p>
    {loading && <p className="section-hint">正在检查接入状态…</p>}
    {!loading && agents.map(([source, name]) => {
      const item = sources.find(item => item.source === source);
      if (!item) return null;
      const webhook = item.kind === 'webhook';
      return <div className="integration-item" key={source} data-integration={source}>
        <div className="integration-title"><strong>{name} <span>{webhook ? 'Webhook' : 'Hooks'}</span></strong><span className="integration-badge" data-state={item.status}>{labels[item.status]}</span></div>
        <p className="integration-detail">{item.message}</p>
        <p className="integration-detail">{item.automatic ? '允许自动接入' : '已关闭自动接入'} · {item.lastEventAt ? `最近事件：${new Date(item.lastEventAt).toLocaleString()}` : '尚无事件记录'}</p>
        {!!item.locations.length && <details><summary>配置位置</summary>{item.locations.map(location => <code key={location}>{location}</code>)}</details>}
        <div className="integration-actions">
          <Button type="button" variant="outline" disabled={disabled || active !== null} onClick={() => void run({source, action: 'install'})}>
            {active === `${source}-install` ? '正在处理…' : webhook ? (item.status === 'installed' ? '重新注册' : '注册 / 重试') : item.status === 'installed' || item.status === 'partial' ? '修复 Hooks' : '安装 Hooks'}
          </Button>
          <Button type="button" variant="outline" disabled={disabled || active !== null || (!item.automatic && item.status === 'not_installed')} onClick={() => void run({source, action: 'uninstall'})}>
            {active === `${source}-uninstall` ? '正在处理…' : webhook ? '注销' : '卸载'}
          </Button>
        </div>
      </div>;
    })}
    <p role="status" className="integration-message">{message}</p>
  </div>;
}
