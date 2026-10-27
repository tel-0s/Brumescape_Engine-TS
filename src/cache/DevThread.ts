import fs from 'fs';
import path from 'path';
import { parentPort } from 'worker_threads';

import { packClient, packServer } from '#tools/pack/PackAll.js';
import Environment from '#/util/Environment.js';
import ModManager from '#/mod/ModManager.js';

// todo: this file queue is so the rebuild/reload process can utilize the additional context
let processNextQueue: Set<string> = new Set();
let processNextTimeout: Timer | null = null;

// prevent other file change events from building multiple times
let active = false;

async function processChangedFiles() {
    active = true;

    // in case another event happens during build we can queue it up for the next change event
    // by copying the old set and creating a new one for the next events
    const queue = processNextQueue;
    processNextQueue = new Set();

    try {
        const modelFlags: number[] = [];
        await packClient(modelFlags);
        await packServer();

        if (parentPort) {
            parentPort.postMessage({
                type: 'dev_reload',
                queue
            });
        }
    } catch (err: unknown) {
        if (parentPort) {
            parentPort.postMessage({
                type: 'dev_failure',
                error: err instanceof Error ? err.message : undefined
            });
        }

        // console.log(err);
    }

    processNextTimeout = null;
    active = false;

    if (processNextQueue.size > 0) {
        // if another event happened during build we prepare to build again
        processNextTimeout = setTimeout(processChangedFiles, 1000);
    }
}

function trackFileChange(filename: string) {
    processNextQueue.add(filename);

    if (active) {
        return;
    }

    if (processNextTimeout) {
        // we want to wait an additional period of time instead of trying to fit this change in on the next run
        clearTimeout(processNextTimeout);
    }

    processNextTimeout = setTimeout(processChangedFiles, 1000);
}

function trackDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const files = fs.readdirSync(dir);

    for (const file of files) {
        const full = path.join(dir, file);
        if (!fs.statSync(full).isDirectory()) {
            continue;
        }

        fs.watch(full, (_event, filename) => {
            if (!filename) {
                return;
            }

            trackFileChange(path.join(full, filename));
        });

        trackDir(full);
    }
}

// Mods: one recursive watcher on the whole mods dir, so edits inside any mod,
// newly added mods and mods.json toggles all trigger a rebuild. The build's
// fingerprint (ModManager.beginBuild) decides what has to be repacked.
function trackModsDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const onChange = (filename: string) => {
        // the build itself writes idmap.json; dotfiles are editor/OS noise
        if (filename === 'idmap.json' || filename.split(/[\\/]/).some(part => part.startsWith('.'))) {
            return;
        }
        trackFileChange(path.join(dir, filename));
    };

    try {
        fs.watch(dir, { recursive: true }, (_event, filename) => {
            if (filename) {
                onChange(filename.toString());
            }
        });
    } catch (_err) {
        // recursive watching is not supported here: watch the root and every
        // directory below it (directories added later are not picked up)
        fs.watch(dir, (_event, filename) => {
            if (filename) {
                onChange(filename.toString());
            }
        });
        trackDir(dir);
    }
}

if (parentPort) {
    parentPort.on('message', msg => {
        if (msg.type === 'world_rebuild') {
            processNextTimeout = setTimeout(processChangedFiles, 1000);
        }
    });
}

trackDir(`${Environment.BUILD_SRC_DIR}/maps`);
trackDir(`${Environment.BUILD_SRC_DIR}/songs`);
trackDir(`${Environment.BUILD_SRC_DIR}/jingles`);
trackDir(`${Environment.BUILD_SRC_DIR}/binary`);
trackDir(`${Environment.BUILD_SRC_DIR}/fonts`);
trackDir(`${Environment.BUILD_SRC_DIR}/title`);
trackDir(`${Environment.BUILD_SRC_DIR}/scripts`);
trackDir(`${Environment.BUILD_SRC_DIR}/sprites`);
trackDir(`${Environment.BUILD_SRC_DIR}/models`);
trackDir(`${Environment.BUILD_SRC_DIR}/textures`);
trackDir(`${Environment.BUILD_SRC_DIR}/synth`);
trackDir(`${Environment.BUILD_SRC_DIR}/wordenc`);
trackModsDir(ModManager.modsDir);
