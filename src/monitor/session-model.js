import { visibleSession } from './session-visibility.js';
import { ACTIVE } from './model.js';

export const PORTRAITS = [
  ['red-panda', '小熊猫'], ['elephant', '大象'], ['penguin', '企鹅'],
  ['pig', '小猪'], ['dragon', '幼龙'], ['lion', '狮子'],
  ['koala', '考拉'], ['owl', '猫头鹰'], ['robot', '小机器人'],
  ['deer', '小鹿'], ['hedgehog', '刺猬'], ['giraffe', '长颈鹿'], ['tiger', '老虎'],
].map(([id, name]) => ({ id, name, avatar: null }));
export const PORTRAIT_STORAGE_KEY = 'astra.desktop.portraits.v2';
const TERMINAL = new Set(['done', 'error', 'aborted']);
export const OPENED_HOLD_MS = 10_000;
export const FINISHED_HOLD_MS = 60 * 60_000;
export const HOST_EXIT_GRACE_MS = 15_000;
export const OVERFLOW_LIMIT = 8;
export const OVERFLOW_HOLD_MS = 10_000;

export function createRailModel({ now = Date.now, storage, holdMs = FINISHED_HOLD_MS } = {}) {
  const rows = new Map(), portraits = new Map(), dismissed = new Set();
  let snapshot = null, connection = 'connecting';
  let overflow = null;
  try {
    for (const [id, index] of JSON.parse(storage?.getItem(PORTRAIT_STORAGE_KEY) || '[]').slice(-256)) {
      if (typeof id === 'string' && Number.isInteger(index) && index >= 0 && index < 1_000_000) portraits.set(id, index);
    }
  } catch { /* An unavailable or old cache does not stop monitoring. */ }
  function portrait(id) {
    const occupied = new Set([...rows.values()].map(row => row.identity.slot));
    if (!portraits.has(id) || occupied.has(portraits.get(id))) {
      const counts = PORTRAITS.map((_, index) => [...occupied].filter(slot => slot % PORTRAITS.length === index).length);
      let slot = counts.indexOf(Math.min(...counts));
      while (occupied.has(slot)) slot += PORTRAITS.length;
      portraits.set(id, slot);
      while (portraits.size > Math.max(256, rows.size + 1)) {
        const old = [...portraits.keys()].find(key => !rows.has(key) && key !== id);
        if (!old) break;
        portraits.delete(old);
      }
      try { storage?.setItem(PORTRAIT_STORAGE_KEY, JSON.stringify([...portraits].slice(-256))); } catch {}
    }
    const slot = portraits.get(id), base = PORTRAITS[slot % PORTRAITS.length];
    const number = Math.floor(slot / PORTRAITS.length) + 1;
    return { ...base, slot, number, name: number > 1 ? `${base.name} ${number}` : base.name };
  }
  function reconcile() {
    if (!snapshot) return;
    const online = connection === 'connected', sessions = new Map(snapshot.sessions.filter(visibleSession).map(s => [s.id, s]));
    for (const [id, row] of rows) {
      const next = sessions.get(id);
      const source = next?.source || row.session?.source;
      const state = snapshot.sources?.[source]?.state;
      const healthy = online && ['ok', 'partial'].includes(state);
      if (state === 'disabled' || (!next && healthy)) { rows.delete(id); continue; }
      // A host-process exit is an observed fact, not a timeout guess: show the
      // result briefly, then retire the row. This must run before the health
      // short-circuit below or an unhealthy source would freeze the row.
      if (online && state === 'exited') {
        if (next) row.session = next;
        row.offline = true;
        row.hostGoneUntil ??= now() + HOST_EXIT_GRACE_MS;
        row.expiresAt = row.hostGoneUntil;
        if (!next || row.hostGoneUntil <= now()) rows.delete(id);
        continue;
      }
      row.hostGoneUntil = null;
      if (next && (!TERMINAL.has(next.status) || row.session?.roundId !== next.roundId)) row.openedUntil = null;
      if (next) row.session = next;
      row.offline = !healthy;
      if (!next || !healthy) continue;
      if (TERMINAL.has(next.status)) {
        if (!row.openedUntil && next.viewedRoundId != null && next.viewedRoundId === next.roundId) {
          dismissed.add(id); rows.delete(id); continue;
        }
        const ended = next.endedAt ?? next.updatedAt ?? now();
        // A host exit keeps its short grace even if the app relaunches before it
        // elapses; a later round is what restores the normal one-hour hold.
        row.expiresAt = row.openedUntil || (next.endedBy === 'host' ? row.hostGoneUntil ?? ended + HOST_EXIT_GRACE_MS : ended + holdMs);
        if (dismissed.has(id) || row.expiresAt <= now()) rows.delete(id);
      } else row.expiresAt = null;
    }
    for (const session of sessions.values()) {
      const healthy = ['ok', 'partial'].includes(snapshot.sources?.[session.source]?.state);
      if (ACTIVE.has(session.status) && online && healthy) {
        dismissed.delete(session.id);
        if (!rows.has(session.id)) { const identity = portrait(session.id); rows.set(session.id, { identity, session, offline: false }); }
      }
    }
    for (const id of dismissed) if (!sessions.has(id)) dismissed.delete(id);
    // Retire one oldest successful completion at a time. A new turn or a
    // recovered source must earn a fresh grace period, never inherit a timer.
    const oldest = [...rows.entries()]
      .filter(([, row]) => !row.offline && row.session.status === 'done')
      .sort((a, b) => (a[1].session.endedAt ?? a[1].session.updatedAt ?? 0)
        - (b[1].session.endedAt ?? b[1].session.updatedAt ?? 0))[0];
    if (rows.size <= OVERFLOW_LIMIT || !oldest) overflow = null;
    else {
      const [id, row] = oldest;
      if (overflow?.id !== id || overflow.roundId !== row.session.roundId) {
        overflow = { id, roundId: row.session.roundId, until: now() + OVERFLOW_HOLD_MS };
      }
      if (overflow.until <= now()) {
        dismissed.add(id); rows.delete(id); overflow = null;
        reconcile();
      }
    }
  }
  return {
    accept(value) { snapshot = value; reconcile(); },
    connect(value) { connection = value; reconcile(); },
    retainOpened(id, roundId) {
      const row = rows.get(id);
      if (!row || !TERMINAL.has(row.session.status) || row.session.roundId !== roundId) return;
      row.openedUntil ??= now() + OPENED_HOLD_MS;
      row.expiresAt = row.openedUntil;
    },
    cancelOpened(id, roundId) {
      const row = rows.get(id);
      if (row?.session.roundId === roundId) { row.openedUntil = null; reconcile(); }
    },
    dismiss(id, roundId) {
      const session = rows.get(id)?.session;
      if (TERMINAL.has(session?.status) && (roundId === undefined || session.roundId === roundId)) {
        dismissed.add(id); rows.delete(id); reconcile();
      }
    },
    refresh: reconcile,
    get items() { return [...rows].map(([id, row]) => ({ id, ...row })); },
    get nextExpiry() { const times = [...rows.values()].filter(row => row.expiresAt && (!row.offline || row.hostGoneUntil)).map(row => row.expiresAt); if (overflow) times.push(overflow.until); return times.length ? Math.min(...times) : null; },
    get snapshot() { return snapshot; },
    get connection() { return connection; },
  };
}
