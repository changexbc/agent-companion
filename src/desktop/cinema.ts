/** Locally generated character portraits; the movie characters are not app branding. */
export const cinemaPortraits = [
  {name: '波妞（人形）', file: 'ponyo-human.png'},
  {name: '龙猫', file: 'totoro.png'},
  {name: '堀越二郎', file: 'jiro.png'},
  {name: '里见菜穗子', file: 'nahoko.png'},
  {name: '宗介', file: 'sosuke.png'},
  {name: '千寻', file: 'chihiro.png'},
  {name: '白龙', file: 'haku.png'},
  {name: '无脸男', file: 'noface.png'},
  {name: '琪琪', file: 'kiki.png'},
  {name: '吉吉', file: 'jiji.png'},
  {name: '哈尔', file: 'howl.png'},
  {name: '苏菲', file: 'sophie.png'},
  {name: '卡西法', file: 'calcifer.png'},
  {name: '珊', file: 'san.png'},
  {name: '阿席达卡', file: 'ashitaka.png'},
  {name: '娜乌西卡', file: 'nausicaa.png'},
  {name: '波妞（金鱼）', file: 'ponyo.png'},
] as const;

export const CINEMA_AVATAR_COUNT = cinemaPortraits.length;
export const cinemaNames = cinemaPortraits.map(portrait => portrait.name);

export function cinemaBody(variant: number) {
  const portrait = cinemaPortraits[variant];
  // SVG image elements keep transparent pixels and the existing motion wrappers.
  return `<g class="companion-work"><g class="companion-pointer"><g class="companion-look"><image class="cinema-portrait" href="/avatars/cinema/${portrait.file}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet"/></g></g></g>`;
}
