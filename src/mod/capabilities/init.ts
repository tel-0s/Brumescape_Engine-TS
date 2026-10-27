// Capability: world-init proc.
//
// mod.json "init": "<proc name>" runs [proc,<name>] once on every world boot,
// after scripts are loaded and the map is ready (e.g. to npc_add/loc_add).
// It re-runs every boot, so placement stays idempotent without persisting the
// spawned entities.

import ModManager from '#/mod/ModManager.js';
import type { ModCapability } from '#/mod/ModTypes.js';
import { printInfo } from '#/util/Logger.js';

const capability: ModCapability = {
    name: 'init',

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
