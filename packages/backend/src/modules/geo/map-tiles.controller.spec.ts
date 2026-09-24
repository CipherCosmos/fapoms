import { BadRequestException, HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import * as fs from 'fs';
import * as path from 'path';
import { MapTilesController } from './map-tiles.controller';

const res = () => {
  const r: any = { headers: {} as Record<string, string> };
  r.setHeader = jest.fn((k: string, v: string) => { r.headers[k] = v; });
  r.send = jest.fn();
  return r;
};

describe('MapTilesController — the India map for every map in the apps', () => {
  it('serves a rendered tile as a cacheable PNG', async () => {
    const tiles = { getTile: jest.fn().mockResolvedValue(Buffer.from('png')) };
    const controller = new MapTilesController(tiles as any);
    const r = res();
    await controller.tile('6', '44', '26.png', r);
    expect(tiles.getTile).toHaveBeenCalledWith({ z: 6, x: 44, y: 26 });
    expect(r.headers['Content-Type']).toBe('image/png');
    expect(r.headers['Cache-Control']).toMatch(/max-age=\d+/);
  });

  it('refuses anything that is not a tile address, before the renderer is asked', async () => {
    const tiles = { getTile: jest.fn() };
    const controller = new MapTilesController(tiles as any);
    for (const [z, x, y] of [['99', '0', '0'], ['6', '-1', '0'], ['6', '0', 'http://evil'], ['a', 'b', 'c']]) {
      await expect(controller.tile(z, x, y, res())).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(tiles.getTile).not.toHaveBeenCalled();
  });

  it('answers 502 when the renderer is down, so a map drops just that square', async () => {
    const controller = new MapTilesController({ getTile: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as any);
    await expect(controller.tile('6', '44', '26', res())).rejects.toMatchObject({ status: 502 });
    await expect(controller.tile('6', '44', '26', res())).rejects.toBeInstanceOf(HttpException);
  });

  it('needs no sign-in (a candidate\'s registration map has none) but is throttled', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MapTilesController)).toBeUndefined();
    const src = fs.readFileSync(path.join(__dirname, 'map-tiles.controller.ts'), 'utf8');
    expect(src).toMatch(/@Throttle\(/);
  });

  it('never fetches from a public OpenStreetMap tile server — the renderer is ours', () => {
    const src = fs.readFileSync(path.join(__dirname, 'tile-proxy.service.ts'), 'utf8');
    const upstream = /const UPSTREAM_TILE_URL =([^;]+);/.exec(src)?.[1] ?? '';
    expect(upstream).toMatch(/india-tiles/);
    expect(upstream).not.toMatch(/openstreetmap\.org|carto|stadia/i);
  });
});
