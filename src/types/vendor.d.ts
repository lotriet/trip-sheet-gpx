declare module "pbf" {
  export default class Pbf {
    constructor(buf?: Uint8Array | ArrayBuffer);
  }
}

declare module "@mapbox/vector-tile" {
  export class VectorTile {
    constructor(pbf: unknown);
    layers: Record<
      string,
      {
        length: number;
        feature(i: number): {
          properties: Record<string, string | number | boolean | undefined>;
          toGeoJSON(
            x: number,
            y: number,
            z: number,
          ): { geometry: { type: string; coordinates: unknown } };
        };
      }
    >;
  }
}
