import type { SourceId } from './settings.js';

export interface IntegrationStatus {
  source: SourceId;
  /** `log` 表示该来源直接读取本地会话日志，没有可安装的接入。 */
  kind: 'hooks' | 'webhook' | 'log';
  status: 'installed' | 'not_installed' | 'partial' | 'error' | 'unavailable' | 'pending' | 'log_only';
  message: string;
  locations: string[];
  automatic: boolean;
  lastEventAt?: number | null;
}
export interface Integrations { sources: IntegrationStatus[] }
export interface IntegrationAction { source: SourceId; action: 'install' | 'uninstall' }
