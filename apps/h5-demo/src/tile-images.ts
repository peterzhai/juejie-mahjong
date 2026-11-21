// Tile IDs in the order they appear on the 9 × 5 photo sheet.
const photoRows = [
  ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'],
  ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'],
  ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'],
  ['WE', 'WS', 'WW', 'WN', 'HR', 'HG', 'HW', 'back'],
  ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'],
];

export const tilePhotoPositions = new Map(
  photoRows.flatMap((tiles, row) =>
    tiles.map((tile, column) => [tile, `${column * 12.5}% ${row * 25}%`] as const),
  ),
);
