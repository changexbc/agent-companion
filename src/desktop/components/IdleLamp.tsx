import * as React from 'react';
import '@/desktop/idle-lamp.css';

// The gradient is referenced by fragment id, so each mounted lamp needs its own.
let sequence = 0;

/** The approved idle lamp: same 40px drawing and 64x72 capsule as the preview. */
export function IdleLamp() {
  const id = React.useMemo(() => `warm-light-${++sequence}`, []);
  return (
    <svg viewBox="0 0 44 44" className="desktop-empty-lamp lamp-art" aria-hidden="true">
      <defs>
        <radialGradient id={id} cx="46%" cy="20%" r="78%">
          <stop stopColor="#f2d99d" stopOpacity=".75" />
          <stop offset="1" stopColor="#f2d99d" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="lamp-light lamp-pool"><ellipse cx="18" cy="35.5" rx="12" ry="3.5" fill="#efd9a4" opacity=".26" /></g>
      <g className="lamp-rig">
        <path d="M29 26L24 36" fill="none" stroke="#7e9584" strokeWidth="3.2" strokeLinecap="round" />
        <g className="lamp-arm-response"><g className="lamp-arm-idle">
          <path d="M25 17L29 26" fill="none" stroke="#7e9584" strokeWidth="3.2" strokeLinecap="round" />
          <g className="lamp-head-response"><g className="lamp-head-idle">
            <g className="lamp-light"><path d="M12 18L3 37Q17 43 30 37L26 18Z" fill={`url(#${id})`} /></g>
            <path d="M10 18L14 7Q14.6 5 17 5H22Q24 5 25 7L29 18Q20 21 10 18Z" fill="#d9b677" />
            <path d="M10 18Q19.5 15 29 18Q19.5 22 10 18Z" fill="#f3dea7" />
            <path d="M16 7H20" stroke="#f0d398" strokeWidth="1.6" strokeLinecap="round" />
          </g></g>
        </g></g>
        <circle cx="29" cy="26" r="2.4" fill="#a7b9a8" />
      </g>
      <path d="M16 36Q16 34 19 34H29Q32 34 33 37V38H15Z" fill="#8fa68e" />
      <path d="M16 38H33" stroke="#6f8a77" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
