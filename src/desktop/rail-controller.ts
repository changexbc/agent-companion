/**
 * The rail's one state owner.
 *
 * Everything that can change what the rail shows goes through here: the session
 * model, the mute set, the expanded flag, the open menu, the notice and the
 * welcome animation. Components read a single frozen snapshot through
 * `useSyncExternalStore` and call back into these methods; none of them keeps a
 * second copy of a rule the model already owns.
 *
 * Three ownership boundaries are worth stating up front, because they are the
 * whole reason this file exists rather than a set of `useEffect`s:
 *
 * 1. `#desktop-rail` is the React *container*, not a React element, so React
 *    never writes its attributes. This controller owns them (`desktop-inactive`,
 *    `companion-motion-paused`, `welcome-blocking`, `welcome-running` and the
 *    `data-welcome*` diagnostics).
 * 2. The card, the automatic cards and the notice are placed by layout, not by
 *    data: whether one is visible depends on where the avatar list happens to be
 *    scrolled. This controller therefore owns `hidden` and `style.top` on those
 *    three, and React only decides that they exist and what they contain.
 *    Nothing declares `style` or `hidden` for them in JSX, so a re-render can
 *    never undo a placement and a placement can never undo a render.
 * 3. The departing ghosts are rendered by React but animated here, because the
 *    ghost has to outlive the row it was cloned from.
 *
 * Animation follows from that: `afterCommit()` runs in a layout effect after
 * every commit and is the only place a Web Animation starts.
 */
import { createRailModel, type RailItem } from './rail-model.js';
import { automaticReminderItems, questionKey } from '../monitor/reminders.js';
import { sessionPresentation } from '../monitor/presentation.js';
import { openSessionLink } from '../monitor/session-link.js';
import { createSSETransport } from '../monitor/transport.js';
import { isDesktop, onDesktopPointer, onDesktopWindowActive } from './host.js';
import { createRailWelcome, type RailWelcomeState } from './welcome/index.js';
import { createHitRegions, type HitRegions } from './hit-regions.js';
import { loadPreferences, watchPreferences } from './preferences.js';
import { observeAvatars, pointAvatar, type AvatarStyle } from './avatar.js';
import { animateArrival, animateHeight, animateReorder, cancelHeightAnimations, leaveSurface, reducedMotion, revealSurface, retireGhost } from './rail-animations.js';
import type { ConnectionState } from '../types/snapshot.js';

const TERMINAL = new Set(['done', 'error', 'aborted']);
const URGENT = new Set(['wait', 'error']);

export interface DepartingGhost {
  key: string;
  kind: 'avatar' | 'card';
  item: RailItem;
  style: {left: number; top: number; width: number; height: number};
}

export interface RailState {
  connection: ConnectionState;
  items: RailItem[];
  avatarStyle: AvatarStyle;
  visibleCount: number;
  expanded: boolean;
  lampAttentive: boolean;
  overflowHidden: boolean;
  overflowText: string;
  overflowLabel: string;
  emptyHidden: boolean;
  emptyLabel: string;
  listHidden: boolean;
  stripEmpty: boolean;
  connectionLabel: string;
  card: {id: string; leaving: boolean} | null;
  automaticIds: string[];
  menuOpen: boolean;
  notice: {text: string} | null;
  replayDisabled: boolean;
  welcome: RailWelcomeState;
  departing: DepartingGhost[];
}

export type RailController = ReturnType<typeof createRailController>;

export function createRailController() {
  let storage: Storage | undefined;
  try { storage = localStorage; } catch { /* An unavailable store only costs the portrait cache. */ }
  const model = createRailModel({ storage });
  const mutedQuestions = new Map<string, string>();

  let avatarStyle: AvatarStyle = 'animal';
  let visibleCount = 8;
  let expanded = false;
  let lampAttentive = false;
  let inactive = false;
  let motionPaused = false;
  let card: {id: string; leaving: boolean} | null = null;
  /**
   * The session the pointer is over, cleared the moment a hide starts rather
   * than when the exit animation ends. The two have to be separate: the
   * pre-migration code re-showed the automatic card for a session while its
   * larger card was still fading out, and keeping `activeId` distinct from
   * `card` is what reproduces that.
   */
  let activeId: string | null = null;
  let menuOpen = false;
  let menuClientY = 0;
  let notice: {text: string} | null = null;
  let departing: DepartingGhost[] = [];
  let animationEnabled = true;
  let menuFocusPending = false;
  let welcome: RailWelcomeState = {phase: 'idle', blocking: false, running: false};
  let activeAnchor: string | null = null;

  // Registered DOM. `avatars` and `automatics` are keyed by session id; the rest
  // are singletons, because the rail has exactly one of each.
  let container: HTMLElement | null = null;
  let strip: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let cardEl: HTMLElement | null = null;
  let noticeEl: HTMLElement | null = null;
  let menuEl: HTMLElement | null = null;
  const avatars = new Map<string, HTMLElement>();
  const automatics = new Map<string, HTMLElement>();
  const lastKnown = new Map<string, RailItem>();
  let ghostSequence = 0;

  // Controller-owned visibility for the placed surfaces, kept apart from the DOM
  // so a freshly mounted element still knows whether it is appearing or moving.
  const visible = new Map<string, boolean>();
  let cardLeaving = false;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  // Measured at the end of the previous commit; the "before" half of every FLIP.
  const measured = {height: 0, avatars: new Map<string, number>()};

  const hitRegions: HitRegions = createHitRegions({isBlocked: () => welcome.blocking});
  // Created against the container rather than `document.body`: the paused state
  // is a class on the rail element, and a document-level class would be a second
  // writer of the same switch.
  let avatarObserver: ReturnType<typeof observeAvatars> | null = null;
  const resize = new ResizeObserver(() => positionAll());
  // The observer only fires when the rail's own box changes. Placing a card also
  // clamps against `innerHeight`, so a window resize has to re-place even when
  // the rail itself is unchanged.
  const onWindowResize = () => positionAll();
  window.addEventListener('resize', onWindowResize);
  const listeners = new Set<() => void>();
  let state: RailState = build();

  function reminders() { return automaticReminderItems(model.items, model.connection, mutedQuestions); }

  function build(): RailState {
    const items = model.items;
    const connection = model.connection;
    const count = items.length;
    const overflowHidden = count <= visibleCount;
    return {
      connection,
      items,
      avatarStyle,
      visibleCount,
      expanded,
      lampAttentive,
      overflowHidden,
      overflowText: expanded ? '−' : `+${count - visibleCount}`,
      overflowLabel: expanded ? '收起更多任务' : `展开其余 ${count - visibleCount} 个任务`,
      emptyHidden: count > 0,
      emptyLabel: connection === 'connected' ? '正在监听，等待新任务' : connection === 'offline' ? '连接已中断，等待重新连接' : '正在连接监听服务',
      listHidden: count === 0,
      stripEmpty: count === 0,
      connectionLabel: connection === 'connected' ? `${count} 个监控会话` : connection === 'offline' ? '连接中断，保留最后状态' : '连接中',
      card,
      automaticIds: reminders().map(item => item.id),
      menuOpen,
      notice,
      replayDisabled: !animationEnabled,
      welcome,
      departing,
    };
  }

  function notify() { for (const listener of listeners) listener(); }

  function applyContainer() {
    if (!container) return;
    container.classList.toggle('desktop-inactive', inactive);
    container.classList.toggle('companion-motion-paused', motionPaused);
    // `welcome-running` before `welcome-blocking`, matching the order the
    // pre-migration classList ended up in; nothing reads the order, but a diff
    // that reports it would be noise.
    container.classList.toggle('welcome-running', welcome.running);
    container.classList.toggle('welcome-blocking', welcome.blocking);
    container.dataset.welcome = welcome.phase;
  }

  function publish() {
    for (const item of model.items) lastKnown.set(item.id, item);
    state = build();
    applyContainer();
    notify();
  }

  // ---------------------------------------------------------------- placement

  /** The surface a notice points at, falling back to the strip itself. */
  function noticeAnchorElement() {
    if (!activeAnchor) return strip;
    const automatic = automatics.get(activeAnchor);
    if (automatic && !automatic.hidden) return automatic;
    if (card?.id === activeAnchor && cardEl && !cardEl.hidden) return cardEl;
    return avatars.get(activeAnchor) || strip;
  }

  function positionNotice() {
    if (!noticeEl) return;
    const anchor = noticeAnchorElement();
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const height = noticeEl.offsetHeight;
    let top = rect.bottom + 10;
    if (top + height > innerHeight - 8) top = rect.top - height - 10;
    noticeEl.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
  }

  function positionPreview(surface: HTMLElement, id: string) {
    const button = avatars.get(id);
    if (!button || button.hidden || !list) { surface.hidden = true; visible.set(id, false); return; }
    const b = button.getBoundingClientRect(), bounds = list.getBoundingClientRect();
    if (b.top < bounds.top || b.bottom > bounds.bottom + 1) { surface.hidden = true; visible.set(id, false); return; }
    surface.style.top = `${Math.max(8, Math.min(b.top, innerHeight - surface.offsetHeight - 8))}px`;
    surface.style.setProperty('--pointer-top', `${b.top + b.height / 2 - parseFloat(surface.style.top)}px`);
  }

  function positionAll() {
    positionNotice();
    if (cardEl && card && !cardEl.hidden) positionPreview(cardEl, card.id);
    for (const [id, surface] of automatics) if (!surface.hidden) positionPreview(surface, id);
    hitRegions.sync();
  }

  function placeAutomatics() {
    for (const [id, surface] of automatics) {
      if (activeId === id || menuOpen) { surface.hidden = true; visible.set(id, false); continue; }
      const was = visible.get(id) ?? false;
      revealSurface(surface, was);
      visible.set(id, true);
      positionPreview(surface, id);
    }
    hitRegions.sync();
  }

  // ------------------------------------------------------------------ surfaces

  function hide() {
    clearTimeout(hideTimer);
    activeId = null;
    if (!card || card.leaving) return;
    cardEl?.getAnimations().forEach(animation => animation.cancel());
    card = {...card, leaving: true};
    publish();
  }

  function finishLeave() {
    cardLeaving = false;
    card = null;
    visible.set('card', false);
    publish();
    placeAutomatics();
  }

  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 180); }

  function show(id: string) {
    clearTimeout(hideTimer);
    const automatic = automatics.get(id);
    if (automatic && !automatic.hidden) {
      // Keep the existing automatic bubble and its animation state intact.
      if (activeId) hide();
      return;
    }
    activeId = id;
    card = {id, leaving: false};
    publish();
    placeAutomatics();
  }

  function closeMenu() {
    menuEl?.querySelectorAll('.native-hover').forEach(element => element.classList.remove('native-hover'));
    if (!menuOpen) return;
    menuOpen = false;
    publish();
    placeAutomatics();
  }

  function showError(error: unknown, id: string | null = null) {
    activeAnchor = id;
    const message = error instanceof Error ? error.message : error;
    notice = {text: String(message || '无法打开，请重试')};
    publish();
    positionNotice();
    hitRegions.sync();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = null; activeAnchor = null; publish(); hitRegions.sync(); }, 5000);
  }

  async function open(item: RailItem) {
    const presentation = sessionPresentation(item.session, item.offline ? 'offline' : model.connection);
    if (!presentation.url) return show(item.id);
    const finished = TERMINAL.has(item.session.status);
    const roundId = item.session.roundId;
    if (finished) { model.retainOpened(item.id, roundId); sync(); }
    try {
      await openSessionLink(presentation.url);
      if (finished) {
        model.retainOpened(item.id, roundId);
        if (activeId === item.id && !model.items.some(row => row.id === item.id)) hide();
        sync();
      }
    } catch (error) {
      if (finished) { model.cancelOpened(item.id, roundId); sync(); }
      showError(error, item.id);
    }
  }

  // ------------------------------------------------------------------ retiring

  /** The pre-migration ghost, rebuilt from React state instead of `cloneNode`. */
  function ghostFor(key: string, kind: DepartingGhost['kind'], item: RailItem | undefined, element: HTMLElement | null) {
    if (!item || !element || element.hidden || reducedMotion()) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    departing = [...departing, {key, kind, item, style: {left: rect.x, top: rect.y, width: rect.width, height: rect.height}}];
  }

  function retireAvatar(id: string) {
    const element = avatars.get(id) ?? null;
    avatars.delete(id);
    hitRegions.unregister(`avatar:${id}`, 'control');
    avatarObserver?.unobserve(element?.querySelector('.companion-avatar'));
    ghostFor(`avatar:${id}:${++ghostSequence}`, 'avatar', lastKnown.get(id), element);
  }

  function retireAutomatic(id: string) {
    const element = automatics.get(id) ?? null;
    automatics.delete(id);
    visible.delete(id);
    hitRegions.unregister(`automatic:${id}`, 'surface');
    ghostFor(`card:${id}:${++ghostSequence}`, 'card', lastKnown.get(id), element);
  }

  // ---------------------------------------------------------------------- sync

  function sync() {
    welcomeController.update(model.items.some(item => URGENT.has(item.session.status)));
    const items = model.items;
    const ids = new Set(items.map(item => item.id));
    for (const [id, key] of mutedQuestions) {
      const item = items.find(row => row.id === id);
      if (!item || item.session.status !== 'wait' || questionKey(item) !== key) mutedQuestions.delete(id);
    }
    const wanted = new Set(reminders().map(item => item.id));
    for (const id of [...avatars.keys()]) if (!ids.has(id)) retireAvatar(id);
    for (const id of [...automatics.keys()]) if (!wanted.has(id)) retireAutomatic(id);
    if (items.length <= visibleCount) expanded = false;
    for (const id of [...lastKnown.keys()]) if (!ids.has(id)) lastKnown.delete(id);
    publish();
    placeAutomatics();
    clearTimeout(expiryTimer);
    if (model.nextExpiry !== null) expiryTimer = setTimeout(() => { model.refresh(); sync(); }, Math.max(1, model.nextExpiry - Date.now() + 1));
  }

  // -------------------------------------------------------------------- welcome

  function welcomeState(next: RailWelcomeState) {
    welcome = next;
    applyContainer();
    state = build();
    notify();
    hitRegions.sync();
  }

  const welcomeController = createRailWelcome({
    rail: () => strip,
    storage,
    auto: isDesktop() || new URLSearchParams(location.search).has('welcome'),
    onStateChange: welcomeState,
    onElapsed: seconds => { if (container) container.dataset.welcomeTime = seconds.toFixed(2); },
  });

  // ------------------------------------------------------------ subscriptions

  let nativeHover: string | null = null;
  let nativeControl: HTMLElement | null = null;

  const unsubscribeWindowActive = onDesktopWindowActive(value => {
    inactive = !value;
    if (!value) lampAttentive = false;
    applyContainer();
    state = build();
    notify();
    welcomeController.setActive(value);
  });

  const unsubscribePointer = onDesktopPointer(point => {
    const target = point ? document.elementFromPoint(point.x, point.y) : null;
    const overStrip = Boolean(target?.closest('.desktop-strip'));
    if (overStrip !== lampAttentive) { lampAttentive = overStrip; publish(); }
    const control = (target?.closest('button:not(:disabled)') as HTMLElement | null) || null;
    if (control !== nativeControl) { nativeControl?.classList.remove('native-hover'); control?.classList.add('native-hover'); nativeControl = control; }
    if (menuOpen) return;
    const avatar = target?.closest('.desktop-avatar') as HTMLElement | null;
    const id = avatar?.dataset.sessionId;
    if (avatar && id) {
      if (nativeHover !== id) pointAvatar(avatars.get(nativeHover ?? ''), null);
      pointAvatar(avatar, point);
      if (nativeHover !== id) { nativeHover = id; show(id); }
      else clearTimeout(hideTimer);
    } else {
      pointAvatar(avatars.get(nativeHover ?? ''), null);
      nativeHover = null;
      if (target?.closest('.desktop-card')) clearTimeout(hideTimer);
      else if (card) scheduleHide();
    }
  });

  function applySettings(settings: {avatarStyle?: string; visibleCount?: number; animation?: boolean} | null) {
    if (!settings) return;
    const count = settings.visibleCount || 8;
    if (count !== visibleCount) expanded = false;
    avatarStyle = settings.avatarStyle === 'bot' ? 'bot' : 'animal';
    visibleCount = count;
    animationEnabled = settings.animation !== false;
    motionPaused = !animationEnabled;
    applyContainer();
    publish();
    welcomeController.setPreferences(settings);
  }

  const unsubscribeSettings = watchPreferences(applySettings);
  const unsubscribeTransport = createSSETransport().subscribe(
    snapshot => { model.accept(snapshot); sync(); },
    value => { if (value === model.connection) return; model.connect(value); sync(); },
  );

  // -------------------------------------------------------------- post-commit

  /**
   * Runs in a layout effect after every commit, before paint. This is the only
   * place a Web Animation starts, and the only place the previous commit's
   * measurements are consumed.
   */
  function afterCommit() {
    if (strip) {
      cancelHeightAnimations(strip);
      const nextHeight = strip.getBoundingClientRect().height;
      const motion = animateHeight(strip, measured.height, nextHeight);
      if (motion) motion.onfinish = () => hitRegions.sync();
      const seen = new Set<string>();
      for (const [id, element] of avatars) {
        if (element.hidden) continue;
        const top = element.getBoundingClientRect().top;
        const previous = measured.avatars.get(id);
        if (previous === undefined) animateArrival(element);
        else animateReorder(element, previous - top);
        seen.add(id);
        measured.avatars.set(id, top);
      }
      for (const id of [...measured.avatars.keys()]) if (!seen.has(id)) measured.avatars.delete(id);
      measured.height = nextHeight;
    }

    if (cardEl && card) {
      if (card.leaving) {
        if (!cardLeaving) { cardLeaving = true; leaveSurface(cardEl, finishLeave); }
      } else {
        cardLeaving = false;
        revealSurface(cardEl, visible.get('card') ?? false);
        visible.set('card', true);
        if (!cardEl.hidden) positionPreview(cardEl, card.id);
      }
    }

    placeAutomatics();

    if (menuOpen && menuEl) {
      menuEl.style.right = '107px';
      menuEl.style.top = `${Math.max(8, Math.min(menuClientY || strip?.offsetTop || 0, innerHeight - menuEl.offsetHeight - 8))}px`;
      // Focus can only move once the menu is visible, so it waits for the commit
      // that un-hid it rather than running inside the event handler.
      if (menuFocusPending) { menuFocusPending = false; menuEl.querySelector('button')?.focus(); }
    }

    if (noticeEl && notice) positionNotice();
    hitRegions.sync();
  }

  return {
    hitRegions,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: () => state,

    attach: {
      container(element: HTMLElement | null) {
        container = element;
        avatarObserver?.dispose();
        avatarObserver = element ? observeAvatars(element) : null;
        applyContainer();
      },
      strip(element: HTMLElement | null) {
        strip = element;
        hitRegions.register('strip', 'surface', element);
        if (element) resize.observe(element);
      },
      list(element: HTMLElement | null) { list = element; },
      card(element: HTMLElement | null) {
        cardEl = element;
        hitRegions.register('card', 'surface', element);
        if (element) resize.observe(element);
      },
      notice(element: HTMLElement | null) { noticeEl = element; hitRegions.register('notice', 'surface', element); },
      menu(element: HTMLElement | null) { menuEl = element; hitRegions.register('menu', 'surface', element); },
      welcome(element: SVGSVGElement | null) { welcomeController.attach(element); },
      lamp(element: Element | null) { avatarObserver?.observe(element); },
      avatar(id: string, element: HTMLElement | null) {
        if (element) { avatars.set(id, element); avatarObserver?.observe(element.querySelector('.companion-avatar')); }
        else { avatars.delete(id); avatarObserver?.unobserve(element); }
        hitRegions.register(`avatar:${id}`, 'control', element);
      },
      automatic(id: string, element: HTMLElement | null) {
        if (element) automatics.set(id, element); else { automatics.delete(id); visible.delete(id); }
        hitRegions.register(`automatic:${id}`, 'surface', element);
      },
    },

    animateGhost(element: HTMLElement | null, key: string) {
      if (!element) return;
      retireGhost(element, () => { departing = departing.filter(ghost => ghost.key !== key); publish(); });
    },

    hoverAvatar(id: string) { show(id); },
    leaveAvatar() { scheduleHide(); },
    pointerMove(id: string, point: {x: number; y: number}) { pointAvatar(avatars.get(id), point); },
    clearPointer(id: string) { pointAvatar(avatars.get(id), null); },
    focusAvatar(id: string) { show(id); },
    clickAvatar(id: string) { const item = model.items.find(row => row.id === id); if (item) void open(item); },
    setLampAttentive(value: boolean) { if (value !== lampAttentive) { lampAttentive = value; publish(); } },

    dismiss(id: string) {
      const item = model.items.find(row => row.id === id);
      if (!item) return;
      if (item.session.status === 'wait') mutedQuestions.set(id, questionKey(item));
      else model.dismiss(id);
      hide();
      sync();
    },
    toggleExpanded() { expanded = !expanded; hide(); publish(); },

    openMenu(clientY: number) {
      notice = null; clearTimeout(noticeTimer); activeAnchor = null;
      clearTimeout(hideTimer); hide();
      menuOpen = true; menuClientY = clientY; menuFocusPending = true;
      publish();
      placeAutomatics();
    },
    closeMenu,

    holdCard() { clearTimeout(hideTimer); },
    /** Scrolling the list moves every placed surface without changing any data. */
    onListScroll() {
      if (activeId && card && cardEl) {
        revealSurface(cardEl, visible.get('card') ?? false);
        visible.set('card', true);
        positionPreview(cardEl, card.id);
      }
      placeAutomatics();
      positionNotice();
    },
    reportError(error: unknown) { showError(error); },

    /**
     * Escape returns focus to the avatar that opened the card. The pre-migration
     * handler called hide() on both sides of the focus call; only the second one
     * could still be observed, so this keeps the order and drops the duplicate.
     */
    escape() {
      const id = card?.id ?? null;
      closeMenu();
      hide();
      if (id) avatars.get(id)?.focus();
    },

    replayWelcome() { welcomeController.play(); },
    closeCard() { hide(); },

    sync,
    afterCommit,

    start() {
      loadPreferences().then(applySettings).catch(error => { welcomeController.setPreferences(null); showError(error); });
      sync();
    },
    dispose() {
      welcomeController.dispose();
      unsubscribeWindowActive(); unsubscribePointer(); unsubscribeSettings(); unsubscribeTransport();
      avatarObserver?.dispose(); resize.disconnect(); window.removeEventListener('resize', onWindowResize);
      clearTimeout(expiryTimer); clearTimeout(hideTimer); clearTimeout(noticeTimer);
    },
  };
}
