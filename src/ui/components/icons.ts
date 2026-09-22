/**
 * 单色图标库（设计 §5.13）：全部 fill="#000" 实心形（GPUIX svg 以 style.color
 * 着色 fill，不用 currentColor）。24×24 网格，Lucide/Phosphor 风格的简化实心转写。
 * 规格三档：导航 19 / 按钮 16 / 内联 12。
 */

const wrap = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`

export const ICONS = {
  terminal: wrap(
    '<polygon fill="#000" points="4.6,5.2 6,3.8 12.2,10 6,16.2 4.6,14.8 9.4,10"/>' +
    '<rect fill="#000" x="11" y="15" width="9" height="2.2" rx="1.1"/>',
  ),
  gitBranch: wrap(
    '<circle fill="#000" cx="6" cy="5" r="2.6"/>' +
    '<circle fill="#000" cx="6" cy="19" r="2.6"/>' +
    '<circle fill="#000" cx="18" cy="7" r="2.6"/>' +
    '<rect fill="#000" x="4.8" y="6.2" width="2.4" height="9.6" rx="1.2"/>' +
    '<rect fill="#000" x="5.8" y="11.8" width="13" height="2.4" rx="1.2"/>',
  ),
  refresh: wrap(
    '<path fill="#000" d="M12 4a8 8 0 1 0 8 8h-2.4A5.6 5.6 0 1 1 12 6.4V10l5-3-5-3v0Z"/>',
  ),
  search: wrap(
    '<path fill="#000" fill-rule="evenodd" d="M10.5 3a7.5 7.5 0 1 0 4.55 13.45l4.25 4.25 1.4-1.4-4.25-4.25A7.5 7.5 0 0 0 10.5 3Zm0 2.4a5.1 5.1 0 1 1 0 10.2 5.1-5.1 0 0 1 0-10.2Z"/>',
  ),
  puzzle: wrap(
    '<path fill="#000" d="M10 3a2 2 0 0 1 4 0v1h3a2 2 0 0 1 2 2v3h-1a2 2 0 0 0 0 4h1v3a2 2 0 0 1-2 2h-3v-1a2 2 0 0 0-4 0v1H7a2 2 0 0 1-2-2v-3h1a2 2 0 0 0 0-4H5V6a2 2 0 0 1 2-2h3V3Z"/>',
  ),
  settings: wrap(
    '<rect fill="#000" x="2" y="4.9" width="7.5" height="2.2" rx="1.1"/>' +
    '<circle fill="#000" cx="12" cy="6" r="3.4"/>' +
    '<rect fill="#000" x="14.5" y="4.9" width="7.5" height="2.2" rx="1.1"/>' +
    '<rect fill="#000" x="2" y="10.9" width="4.5" height="2.2" rx="1.1"/>' +
    '<circle fill="#000" cx="9" cy="12" r="3.4"/>' +
    '<rect fill="#000" x="11.5" y="10.9" width="10.5" height="2.2" rx="1.1"/>' +
    '<rect fill="#000" x="2" y="16.9" width="10.5" height="2.2" rx="1.1"/>' +
    '<circle fill="#000" cx="17" cy="18" r="3.4"/>' +
    '<rect fill="#000" x="19.5" y="16.9" width="2.5" height="2.2" rx="1.1"/>',
  ),
  info: wrap(
    '<path fill="#000" fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm-1.3 5h2.6v6.6h-2.6V11.2Z"/>',
  ),
  play: wrap(
    '<path fill="#000" d="M7 4.8v14.4c0 .9 1 1.5 1.8 1L20.6 13a1.2 1.2 0 0 0 0-2L8.8 3.8C8 3.3 7 3.9 7 4.8Z"/>',
  ),
  stop: wrap('<rect fill="#000" x="5" y="5" width="14" height="14" rx="2.5"/>'),
  minus: wrap('<rect fill="#000" x="4" y="10.9" width="16" height="2.2" rx="1.1"/>'),
  download: wrap(
    '<path fill="#000" d="M11 3h2v8.2l3-3 1.4 1.4L12 15l-5.4-5.4L8 8.2l3 3V3Z"/>' +
    '<rect fill="#000" x="4" y="17" width="16" height="2.6" rx="1.3"/>',
  ),
  trash: wrap(
    '<rect fill="#000" x="3" y="5" width="18" height="2.2" rx="1.1"/>' +
    '<rect fill="#000" x="9.4" y="2.6" width="5.2" height="2.4" rx="1.2"/>' +
    '<path fill="#000" d="M5.4 8.6h13.2l-1 11.2a2 2 0 0 1-2 1.8H8.4a2 2 0 0 1-2-1.8L5.4 8.6Z"/>',
  ),
  x: wrap(
    '<path fill="#000" d="M5.7 4.3 12 10.6l6.3-6.3 1.4 1.4L13.4 12l6.3 6.3-1.4 1.4L12 13.4l-6.3 6.3-1.4-1.4L10.6 12 4.3 5.7l1.4-1.4Z"/>',
  ),
  check: wrap(
    '<path fill="#000" d="M9.6 16.2 5.4 12l-1.4 1.4 5.6 5.6L20.2 8.4 18.8 7 9.6 16.2Z"/>',
  ),
  chevronDown: wrap(
    '<path fill="#000" d="M6 9.2 12 15.2 18 9.2 19.4 10.6 12 18 4.6 10.6 6 9.2Z"/>',
  ),
  sun: wrap(
    '<circle fill="#000" cx="12" cy="12" r="4.2"/>' +
    '<rect fill="#000" x="11" y="1.6" width="2" height="4" rx="1"/>' +
    '<rect fill="#000" x="11" y="18.4" width="2" height="4" rx="1"/>' +
    '<rect fill="#000" x="1.6" y="11" width="4" height="2" rx="1"/>' +
    '<rect fill="#000" x="18.4" y="11" width="4" height="2" rx="1"/>' +
    '<rect fill="#000" x="17.5" y="4.1" width="2.6" height="2.6" rx="0.8"/>' +
    '<rect fill="#000" x="3.9" y="4.1" width="2.6" height="2.6" rx="0.8"/>' +
    '<rect fill="#000" x="17.5" y="17.3" width="2.6" height="2.6" rx="0.8"/>' +
    '<rect fill="#000" x="3.9" y="17.3" width="2.6" height="2.6" rx="0.8"/>',
  ),
  moon: wrap(
    '<path fill="#000" d="M20.4 14.2A8.8 8.8 0 0 1 9.8 3.6 8.9 8.9 0 1 0 20.4 14.2Z"/>',
  ),
  externalLink: wrap(
    '<path fill="#000" d="M14 3h7v7h-2.4V7.1l-8.3 8.3-1.7-1.7L16.9 5.4H14V3Z"/>' +
    '<path fill="#000" fill-rule="evenodd" d="M5 4.2h5v2.4H7.4v10h10V14H19v4.4a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 18.4V4.2Z"/>',
  ),
  copy: wrap(
    '<path fill="#000" d="M8 2h9a3 3 0 0 1 3 3v9h-2.6V5.6A1.4 1.4 0 0 0 16 4.2H8V2Z"/>' +
    '<path fill="#000" fill-rule="evenodd" d="M5 5.4h9a3 3 0 0 1 3 3V20a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8.4a3 3 0 0 1 3-3Z"/>',
  ),
  alertTriangle: wrap(
    '<path fill="#000" fill-rule="evenodd" d="M10.3 3.9a2 2 0 0 1 3.4 0l8 13.8a2 2 0 0 1-1.7 2.9H4a2 2 0 0 1-1.7-2.9L10.3 3.9Zm1.7 4.5a1.4 1.4 0 0 1 1.4 1.4v3.4a1.4 1.4 0 0 1-2.8 0V9.8a1.4 1.4 0 0 1 1.4-1.4Zm0 7.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z"/>',
  ),
  hardDrive: wrap(
    '<path fill="#000" fill-rule="evenodd" d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm13 9.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z"/>',
  ),
  folder: wrap(
    '<path fill="#000" d="M3 6a2 2 0 0 1 2-2h4l2.4 2.6H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>',
  ),
  heart: wrap(
    '<path fill="#000" d="M12 21S3.5 15.4 3.5 9.6A5.1 5.1 0 0 1 12 6.4a5.1 5.1 0 0 1 8.5 3.2c0 5.8-8.5 11.4-8.5 11.4Z"/>',
  ),
  sync: wrap(
    '<path fill="#000" d="M12 4a8 8 0 0 1 7.4 4.9l1.5-2.2.9 3.6-3.7.4.9-1.9A6.2 6.2 0 0 0 6.3 9.7L4.6 9A8 8 0 0 1 12 4Z"/>' +
    '<path fill="#000" d="M12 20a8 8 0 0 1-7.4-4.9l-1.5 2.2-.9-3.6 3.7-.4-.9 1.9a6.2 6.2 0 0 0 12.7-.9l1.7.7A8 8 0 0 1 12 20Z"/>',
  ),
  archive: wrap(
    '<rect fill="#000" x="3" y="3.6" width="18" height="4" rx="1.2"/>' +
    '<path fill="#000" d="M4.6 9.2h14.8V20a1.6 1.6 0 0 1-1.6 1.6H6.2A1.6 1.6 0 0 1 4.6 20V9.2Z"/>' +
    '<rect fill="#000" x="10.4" y="10.8" width="3.2" height="2.2" rx="0.4"/>',
  ),
  edit: wrap(
    '<path fill="#000" d="M16.9 3.1a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L8.5 19.5l-4.6 1.6 1.6-4.6L16.9 3.1Z"/>',
  ),
  save: wrap(
    '<path fill="#000" fill-rule="evenodd" d="M5 3h11.2L21 7.8V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 2v5h8V5H7Zm6 8v6h4v-6h-4Z"/>',
  ),
  box: wrap(
    '<path fill="#000" fill-rule="evenodd" d="M12 2 3 6.6v10.8L12 22l9-4.6V6.6L12 2Zm0 2.6 6 3.1L12 10.8 6 7.7l6-3.1Z"/>',
  ),
} as const

export type IconName = keyof typeof ICONS
