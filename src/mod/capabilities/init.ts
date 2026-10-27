// Capability: world-init proc.
//
// mod.json "init": "<proc name>" runs [proc,<name>] once on every world boot,
// after scripts are loaded and the map is ready (e.g. to npc_add/loc_add).
// It re-runs every boot, so placement stays idempotent without persisting the
// spawned entities. The build stops when no enabled mod or base content
// defines the proc.

import ModManager from '#/mod/ModManager.js';
import type { ModCapability } from '#/mod/ModTypes.js';
import { printInfo } from '#/util/Logger.js';
import { ScriptPack } from '#tools/pack/PackFile.js';

const capability: ModCapability = {
    name: 'init',

    // After scripts.ts registered every mod script name
    afterRevalidate() {
        for (const mod of ModManager.mods) {
            const procName = mod.manifest.init;
            if (procName !== undefined && ScriptPack.getByName(`[proc,${procName}]`) === -1) {
                throw ModManager.error(
                    { mod, path: `${mod.dir}/mod.json`, relPath: 'mod.json', subPath: 'mod.json', name: 'mod', ext: '.json' },
                    null,
                    `"init": "${procName}", but no script defines [proc,${procName}]. Add the proc to scripts/, or remove the "init" line.`
                );
            }
        }
    },

    async worldBoot() {
        const { default: ScriptProvider } = await import('#/engine/script/ScriptProvider.js');
        const { default: ScriptRunner } = await import('#/engine/script/ScriptRunner.js');

        for (const mod of ModManager.mods) {
            const procName = mod.manifest.init;
            if (!procName) {
                continue;
            }

            const script = ScriptProvider.getByName(`[proc,${procName}]`);
            if (!script) {
                ModManager.warn(mod, null, `init proc [proc,${procName}] not found`);
                continue;
            }

            try {
                ScriptRunner.execute(ScriptRunner.init(script, null, null, []));
                printInfo(`[mods] Ran init for ${mod.name}`);
            } catch (err) {
                ModManager.warn(mod, null, `init proc [proc,${procName}] failed: ${err}`);
            }
        }
    }
};

export default capability;
