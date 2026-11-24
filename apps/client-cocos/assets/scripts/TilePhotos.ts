import { Rect, Size, SpriteFrame, Texture2D, resources } from 'cc';

// Row order of the Hong Kong mahjong photograph in resources.
const rows = [
  ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'],
  ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'],
  ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'],
  ['WE', 'WS', 'WW', 'WN', 'HR', 'HG', 'HW', 'back'],
  ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'],
];

let loading: Promise<ReadonlyMap<string, SpriteFrame>> | undefined;

export function loadTilePhotos(): Promise<ReadonlyMap<string, SpriteFrame>> {
  loading ??= new Promise((resolve, reject) => {
    resources.load('mahjong-tiles/texture', Texture2D, (error, texture) => {
      if (error) {
        reject(error);
        return;
      }
      const width = texture.width / 9;
      const height = texture.height / rows.length;
      const frames = new Map<string, SpriteFrame>();
      rows.forEach((tiles, row) => tiles.forEach((tile, column) => {
        const frame = new SpriteFrame();
        frame.name = tile;
        frame.packable = false;
        frame.reset({
          texture,
          rect: new Rect(column * width, row * height, width, height),
          originalSize: new Size(width, height),
        });
        frames.set(tile, frame);
      }));
      resolve(frames);
    });
  });
  return loading;
}
