// Capability: RuneScript.
//
// Mod layout: scripts/**/*.rs2.

import fs from 'fs';
import path from 'path';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability } from '#/mod/ModTypes.js';
import Environment from '#/util/Environment.js';

const capability: ModCapability = {
    name: 'scripts',

    // Copy mod scripts into the content scripts dir so the compiler and the
    // script pack pick them up.
    prepare() {
        const modScriptDir = `${Environment.BUILD_SRC_DIR}/scripts/_mods`;
        if (fs.existsSync(modScriptDir)) {
            fs.rmSync(modScriptDir, { recursive: true, force: true });
        }

        for (const file of ModManager.listFiles('scripts', '.rs2')) {
            fs.mkdirSync(modScriptDir, { recursive: true });
            fs.copyFileSync(file.path, path.join(modScriptDir, path.basename(file.path)));
        }
    }
};

export default capability;
