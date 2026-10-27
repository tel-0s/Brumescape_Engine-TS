// A mods dir with no mods. Run right after the maps fixture
// (`bun run mod:fixture maps maps-removed`, or --all) to prove that removing
// map mods restores base map data exactly. It also passes on its own.

import fs from 'fs';
import path from 'path';

import Environment from '#/util/Environment.js';
import { expect, readBasePack } from '#tools/mod/Inspect.js';
import { expectedFromJm2, readClientSquare, readMapIndex, readServerSquare, sortSquare } from '#tools/mod/MapInspect.js';
import { parseJm2 } from '#tools/pack/map/Jm2.js';

const basePack = readBasePack('map');
const index = readMapIndex();
expect(index.length === basePack.size / 2 && index.every(e => basePack.get(`m${e.x}_${e.z}`) === e.land), `map_index is exactly the ${basePack.size / 2} base squares`);

for (const name of ['m60_50', 'm61_50']) {
    const files = ['client/maps/m', 'client/maps/l', 'server/maps/m', 'server/maps/l', 'server/maps/n', 'server/maps/o'].map(p => `data/pack/${p}${name.substring(1)}`);
    expect(
        files.every(f => !fs.existsSync(f)),
        `no packed files left for the removed square ${name}`
    );
}
expect(!fs.existsSync('data/pack/server/free2play.csv') && !fs.existsSync('data/pack/server/multiway.csv'), 'no merged zone lists: the server reads the base ones');
expect(!fs.existsSync('data/pack/mods/maps') || fs.readdirSync('data/pack/mods/maps').length === 0, 'no staged map squares');

for (const [mx, mz] of [
    [50, 50],
    [29, 75]
]) {
    const name = `m${mx}_${mz}`;
    const base = parseJm2(fs.readFileSync(path.join(Environment.BUILD_SRC_DIR, 'maps', `${name}.jm2`), 'utf-8'), { error: (line, message) => new Error(`${name}.jm2:${line}: ${message}`) });
    const expected = JSON.stringify(expectedFromJm2(base));
    expect(JSON.stringify(sortSquare(readServerSquare(mx, mz)!)) === expected, `${name}: server data is base content again`);
    const client = readClientSquare(mx, mz)!;
    expect(
        JSON.stringify(client.tiles) === JSON.stringify(expectedFromJm2(base).tiles) && JSON.stringify(sortSquare({ ...client, npcs: [], objs: [] }).locs) === JSON.stringify(expectedFromJm2(base).locs),
        `${name}: client data is base content again`
    );
}
