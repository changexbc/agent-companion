// Offline DiceBear Critters 10.6.0 artwork, CC0 1.0. See public/licenses/critters.md.
import data from './critters-data.json';
import type { AvatarStatus } from './avatar.js';

export const CRITTER_AVATAR_COUNT = data.portraits.length;
export const critterNames = data.portraits.map(portrait => portrait.name);

export function critterBody(variant: number, id: string) {
  const portrait = data.portraits[variant];
  const anatomy = portrait.body.replaceAll('__CRITTER_ID__', `critter-${id}-`);
  // An inner viewport crops the official busts without clipping status rings.
  const clip = `critter-${id}-viewport`;
  return `<defs><clipPath id="${clip}"><rect width="100" height="100" rx="18"/></clipPath></defs><g transform="translate(5 3) scale(.9)" fill="none"><g clip-path="url(#${clip})"><g class="companion-work">${anatomy}<g class="companion-pointer"><g class="companion-look"><g class="critter-eyes" transform="translate(27 36)" data-eyes="${portrait.eyes}">${data.eyes[portrait.eyes as keyof typeof data.eyes]}</g><g class="critter-mouth" transform="translate(36 60)">${data.mouths.smile}</g></g></g></g></g></g>`;
}

export function updateCritter(node: SVGSVGElement, state: AvatarStatus) {
  const eyes = node.querySelector<SVGGElement>('.critter-eyes');
  const mouth = node.querySelector<SVGGElement>('.critter-mouth');
  const expression = {
    idle: [eyes?.dataset.eyes ?? 'round', 'smile'],
    running: [eyes?.dataset.eyes ?? 'round', 'tinySmile'],
    wait: ['wide', 'ooh'],
    done: ['happy', 'laugh'],
    error: ['angry', 'frown'],
    sleep: ['closedLine', 'line'],
    offline: ['closedLine', 'line'],
  }[state];
  if (eyes) eyes.innerHTML = data.eyes[expression[0] as keyof typeof data.eyes];
  if (mouth) mouth.innerHTML = data.mouths[expression[1] as keyof typeof data.mouths];
}
