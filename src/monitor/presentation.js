import { STATUS, sessionHeadline } from './model.js';
import { agentSessionLink, codeBuddyFolderLink, sessionBadge, sessionSourceLabel } from './session-link.js';

// Shared by the office card and the desktop rail. No scene or DOM dependencies.
export function sessionPresentation(session, connection = 'connected', sourceHealth) {
  const unavailable = connection !== 'connected' || (sourceHealth && !['ok', 'partial'].includes(sourceHealth.state));
  const status = unavailable ? 'offline' : session?.status || 'idle';
  const pending = session?.pending?.[0];
  return {
    status,
    statusLabel: session?.endedBy === 'host' ? '已退出' : status === 'running' && session?.permissionChecks?.length ? '权限检查中' : STATUS[status] || status,
    title: sessionHeadline(session, status),
    provider: sessionSourceLabel(session),
    badge: sessionBadge(session),
    question: status === 'wait' ? pending?.questions?.[0]?.text || pending?.text || '' : '',
    url: agentSessionLink(session),
    action: session?.source === 'codebuddy-ide' ? (codeBuddyFolderLink(session.cwd) ? '打开工程' : '打开 CodeBuddy') : '进入对话',
  };
}
