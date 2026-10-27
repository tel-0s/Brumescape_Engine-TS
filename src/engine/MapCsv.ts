import fs from 'fs';

import Environment from '#/util/Environment.js';

// Zone lists of the game map: free2play.csv (free-to-play zones) and
// multiway.csv (multi-combat zones). Base content keeps them in maps/. When
// mods add or remove zones, the build writes the merged list to
// data/pack/server/<name> (src/mod/capabilities/maps.ts), and that file is
// used instead of the base one.
export const MAP_CSV_NAMES = ['free2play.csv', 'multiway.csv'] as const;
export type MapCsvName = (typeof MAP_CSV_NAMES)[number];

export function mergedMapCsvPath(name: MapCsvName): string {
    return `data/pack/server/${name}`;
}

export function mapCsvPath(name: MapCsvName): string {
    const merged = mergedMapCsvPath(name);
    return fs.existsSync(merged) ? merged : `${Environment.BUILD_SRC_DIR}/maps/${name}`;
}

export function readMapCsv(name: MapCsvName): string[] {
    return fs.readFileSync(mapCsvPath(name), 'ascii').replace(/\r/g, '').split('\n');
}
