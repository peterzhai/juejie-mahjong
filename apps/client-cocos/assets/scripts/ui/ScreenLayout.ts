export interface ScreenObstructions {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** 左边界以画布中心为原点，垂直边界从屏幕顶边向下量。 */
  menu: { left: number; top: number; bottom: number } | null;
}

export function layoutHeader(
  width: number,
  height: number,
  screen: ScreenObstructions,
  controlsWidth: number,
  leadingWidth: number,
  rowHeight: number,
  margin: number,
  preferredY: number,
) {
  const gap = 8;
  const left = -width / 2 + screen.left + margin;
  const right = width / 2 - screen.right - margin;
  const halfRow = rowHeight / 2;
  let row = Math.max(preferredY, screen.top + halfRow + 4);
  let controlsRight = right;
  const menu = screen.menu;
  if (menu && row - halfRow < menu.bottom + gap && row + halfRow > menu.top - gap) {
    const clearance = Math.min(right, menu.left - gap);
    if (clearance - left >= controlsWidth) controlsRight = clearance;
    else row = menu.bottom + gap + halfRow;
  }
  const leadingRow = leadingWidth > 0 && controlsRight - left < controlsWidth + leadingWidth + gap
    ? Math.max(row + rowHeight + 4, (menu?.bottom ?? 0) + gap + halfRow)
    : row;
  return {
    controlsRight,
    y: height / 2 - row,
    leadingX: left + leadingWidth / 2,
    leadingY: height / 2 - leadingRow,
    bottom: leadingRow + halfRow,
  };
}
