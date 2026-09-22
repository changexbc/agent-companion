import * as React from 'react';
import { avatarBody, avatarParts, updateAvatar, type AvatarStyle } from '../avatar.js';

/**
 * The portrait.
 *
 * The wrapper `<svg>` and the constant anatomy belong to React; the eyelids do
 * not, because `updateAvatar` rewrites their `d` on every status change and the
 * transition into `running` depends on reading the *previous* state back off the
 * node. Declaring `data-state` or the lid paths in JSX would make React the
 * second writer of the same two attributes.
 *
 * `updateAvatar` is idempotent — it returns immediately when the state has not
 * changed — so running it after every render costs nothing and keeps the node
 * correct even when React has just replaced the markup for a new avatar style.
 */
export function AvatarPortrait({style, slot, status}: {style: AvatarStyle; slot: number; status: string}) {
  const parts = React.useMemo(() => avatarParts(style, slot), [style, slot]);
  const node = React.useRef<SVGSVGElement | null>(null);
  React.useLayoutEffect(() => {
    if (node.current) updateAvatar(node.current, status);
  });
  return (
    <svg
      ref={node}
      className="companion-avatar desktop-portrait"
      viewBox="0 0 100 100"
      aria-hidden="true"
      data-character={parts.character}
      data-style={parts.style}
      style={parts.variables as React.CSSProperties}
      dangerouslySetInnerHTML={{__html: avatarBody(parts)}}
    />
  );
}
