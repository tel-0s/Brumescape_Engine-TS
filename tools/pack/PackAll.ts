import path from 'path';
import child_process from 'child_process';
import fs from 'fs';
import { parentPort } from 'worker_threads';

import * as fflate from 'fflate';

import Environment from '#/util/Environment.js';
import { ModelPack, revalidatePack } from '#tools/pack/PackFile.js';
import { packClientWordenc } from '#tools/pack/chat/pack.js';
import { packConfigs } from '#tools/pack/config/PackShared.js';
import { packClientModel } from '#tools/pack/graphics/pack.js';
import { packClientInterface } from '#tools/pack/interface/PackClient.js';
import { packMaps } from '#tools/pack/map/Pack.js';
import { packClientMusic } from '#tools/pack/midi/pack.js';
import { packClientSound } from '#tools/pack/sound/pack.js';
import { packClientMedia } from '#tools/pack/sprite/media.js';
import { packClientTexture } from '#tools/pack/sprite/textures.js';
import { packClientTitle } from '#tools/pack/sprite/title.js';
import { generateServerSymbols } from '#tools/pack/CompilerSymbols.js';
import FileStream from '#/io/FileStream.js';
import { packClientVersionList } from '#tools/pack/versionlist/pack.js';
import { clearFsCache } from '#tools/pack/FsCache.js';
import Packet from '#/io/Packet.js';

import ModManager from '#/mod/ModManager.js';

export async function packClient(modelFlags: number[]) {
    await injectModScripts();

    if (parentPort) {
        parentPort.postMessage({
            type: 'dev_progress',
            broadcast: 'Packing client cache (0%)'
        });
    }

    clearFsCache();
    revalidatePack();

    for (let i = 0; i < ModelPack.max; i++) {
        modelFlags[i] = 0;
    }

    const cache = new FileStream('data/pack', true);

    await packClientTitle(cache);
    await packConfigs(cache, modelFlags);
    packClientInterface(cache, modelFlags);
    await packClientMedia(cache);
    await packClientTexture(cache);

    packClientWordenc(cache);
    packClientSound(cache);
    packClientModel(cache, modelFlags);
    packMaps(cache);
    packClientMusic(cache);
    packClientVersionList(cache, modelFlags);

    const build = Packet.alloc(0);
    build.p4(Date.now() / 1000);
    build.save('data/pack/server/build');

    const zipPack: Record<string, Uint8Array> = {};
    for (let archive = 1; archive <= 4; archive++) {
        const count = cache.count(archive);
        for (let file = 0; file < count; file++) {
            const data = cache.read(archive, file);
            if (!data) {
                continue;
            }

            zipPack[`${archive}.${file}`] = data;
        }
    }
    const zip = fflate.zipSync(zipPack, { level: 0 });
    fs.writeFileSync('data/pack/ondemand.zip', zip);

    if (parentPort) {
        parentPort.postMessage({
            type: 'dev_progress',
            text: 'Packed client cache'
        });
    }
}

async function injectModScripts() {
    // Inject mod scripts into the build list
    const modScriptDir = `${Environment.BUILD_SRC_DIR}/scripts/_mods`;
    if (fs.existsSync(modScriptDir)) {
        fs.rmSync(modScriptDir, { recursive: true, force: true });
    }
    
    await ModManager.init();

    for (const mod of ModManager.mods) {
        if (mod.scriptPath) {
            if (!fs.existsSync(modScriptDir)) {
                fs.mkdirSync(modScriptDir, { recursive: true });
            }
            
            const files = fs.readdirSync(mod.scriptPath);
            for (const file of files) {
                if (file.endsWith('.rs2')) {
                    fs.copyFileSync(path.join(mod.scriptPath, file), path.join(modScriptDir, file));
                }
            }
        }
    }

    // shouldBuild() only tracks base content + tool mtimes, so it would skip a
    // config type that only a mod changed and the injection (which happens
    // inside readConfigs) would never run. Invalidate the cached server .dat for
    // every config type a mod provides, forcing that type to repack and thus
    // re-run injection + symbol generation. Works for any future type too.
    for (const mod of ModManager.mods) {
        for (const file of mod.configFiles) {
            const dat = `data/pack/server/${path.extname(file).slice(1)}.dat`;
            if (fs.existsSync(dat)) {
                fs.rmSync(dat);
            }
        }
    }
}

export async function packServer() {
    if (!fs.existsSync('RuneScriptCompiler.jar')) {
        throw new Error('The RuneScript compiler is missing and the build process cannot continue.');
    }

    if (parentPort) {
        parentPort.postMessage({
            type: 'dev_progress',
            broadcast: 'Packing server cache (50%)'
        });
    }

    await generateServerSymbols();

    if (parentPort) {
        parentPort.postMessage({
            type: 'dev_progress',
            text: 'Compiling server scripts'
        });
    }

    try {
        child_process.execSync(`"${Environment.BUILD_JAVA_PATH}" -jar RuneScriptCompiler.jar`, { stdio: 'inherit' });
    } catch (_err) {
        // Always surface a compiler failure so the build exits non-zero, even
        // when not running inside a dev worker (parentPort === null).
        throw new Error('Failed to compile scripts.');
    }

    if (parentPort) {
        parentPort.postMessage({
            type: 'dev_progress',
            text: 'Packed server cache'
        });
    }
}
