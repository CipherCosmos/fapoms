import { BadRequestException, Controller, Get, HttpException, HttpStatus, Logger, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { InvalidTileError, TileProxyService, parseTileCoords } from './tile-proxy.service';

/**
 * Map tiles for every map in the web and mobile apps — the India map (see tile-proxy.service.ts).
 *
 * Public, deliberately. It was signed-in only while the upstream was OpenStreetMap's servers,
 * because an open proxy onto somebody else's donated infrastructure is not ours to offer. Two
 * things changed that: the upstream is now our own renderer on an internal network, and the maps
 * that need tiles include ones nobody is signed in to — a candidate's registration link (whose map
 * was blank on the phone for exactly this reason) — and a browser map library cannot attach a
 * bearer token to the images it loads. The z/x/y validation remains the boundary: only integers
 * in range ever reach the renderer, and the throttle bounds what one address can ask for.
 */
@ApiTags('Map tiles')
@Controller('geo/tiles')
export class MapTilesController {
  private readonly logger = new Logger(MapTilesController.name);

  constructor(private readonly tiles: TileProxyService) {}

  @Get(':z/:x/:y')
  // A map view loads a few dozen tiles and every pan a few dozen more; this is several minutes of
  // brisk panning per minute, and far short of harvesting a country's worth of tiles.
  @Throttle({ default: { limit: 900, ttl: 60_000 } })
  @ApiOperation({ summary: 'India map raster tile (PNG), rendered and cached by us' })
  async tile(
    @Param('z') z: string,
    @Param('x') x: string,
    @Param('y') y: string,
    @Res() res: Response,
  ) {
    let coords: ReturnType<typeof parseTileCoords>;
    try {
      // Leaflet asks for `12.png`-style names when told to; accept the suffix and ignore it.
      coords = parseTileCoords(z, x, y.replace(/\.png$/, ''));
    } catch (err) {
      if (err instanceof InvalidTileError) throw new BadRequestException(err.message);
      throw err;
    }

    let png: Buffer;
    try {
      png = await this.tiles.getTile(coords);
    } catch (err) {
      // The renderer being unreachable is not this API failing. A 502 lets each map drop that one
      // square to its background, which is how every map here treats a tile it cannot load.
      this.logger.warn(`tile ${coords.z}/${coords.x}/${coords.y} upstream failed: ${(err as Error).message}`);
      throw new HttpException('Tile source unavailable', HttpStatus.BAD_GATEWAY);
    }

    res.setHeader('Content-Type', 'image/png');
    // A week, not forever: the URL carries no style version, so a changed map reaches devices
    // within days rather than never.
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(png);
  }
}
