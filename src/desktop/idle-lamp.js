import './idle-lamp.css';

const NS = 'http://www.w3.org/2000/svg';
let sequence = 0;

export function createIdleLamp() {
  const id = `warm-light-${++sequence}`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 44 44');
  svg.setAttribute('class', 'desktop-empty-lamp lamp-art');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<defs>
    <radialGradient id="${id}" cx="46%" cy="20%" r="78%"><stop stop-color="#f2d99d" stop-opacity=".75"/><stop offset="1" stop-color="#f2d99d" stop-opacity="0"/></radialGradient>
  </defs>
  <g class="lamp-light lamp-pool"><ellipse cx="18" cy="35.5" rx="12" ry="3.5" fill="#efd9a4" opacity=".26"/></g>
  <g class="lamp-rig">
    <path d="M29 26L24 36" fill="none" stroke="#7e9584" stroke-width="3.2" stroke-linecap="round"/>
    <g class="lamp-arm-response"><g class="lamp-arm-idle">
      <path d="M25 17L29 26" fill="none" stroke="#7e9584" stroke-width="3.2" stroke-linecap="round"/>
      <g class="lamp-head-response"><g class="lamp-head-idle">
        <g class="lamp-light"><path d="M12 18L3 37Q17 43 30 37L26 18Z" fill="url(#${id})"/></g>
        <path d="M10 18L14 7Q14.6 5 17 5H22Q24 5 25 7L29 18Q20 21 10 18Z" fill="#d9b677"/>
        <path d="M10 18Q19.5 15 29 18Q19.5 22 10 18Z" fill="#f3dea7"/>
        <path d="M16 7H20" stroke="#f0d398" stroke-width="1.6" stroke-linecap="round"/>
      </g></g>
    </g></g>
    <circle cx="29" cy="26" r="2.4" fill="#a7b9a8"/>
  </g>
  <path d="M16 36Q16 34 19 34H29Q32 34 33 37V38H15Z" fill="#8fa68e"/>
  <path d="M16 38H33" stroke="#6f8a77" stroke-width="1.7" stroke-linecap="round"/>`;
  return svg;
}
