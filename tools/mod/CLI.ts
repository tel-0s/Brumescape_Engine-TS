import fs from 'fs';
import path from 'path';

import { select, input } from '@inquirer/prompts';
import kleur from 'kleur';

import { discoverMods, findInstalledMods, readModsConfig, writeModsConfig } from '#/mod/ModDiscovery.js';

const MODS_DIR = 'mods';

const USAGE = `Usage: bun run mod [command]

Commands:
  (none)            interactive menu
  list              show installed mods in load order, and disabled mods
  create            scaffold a new mod (interactive)
  enable <name>     enable a mod (removes it from mods.json "disabled")
  disable <name>    disable a mod without deleting it (adds it to mods.json "disabled")`;

async function main() {
    const [command, arg] = process.argv.slice(2);

    if (!fs.existsSync(MODS_DIR)) {
        fs.mkdirSync(MODS_DIR, { recursive: true });
    }

    switch (command) {
        case undefined:
            return interactive();
        case 'list':
            return listMods();
        case 'create':
            return createMod();
        case 'enable':
        case 'disable':
            return setEnabled(arg, command === 'enable');
        case 'help':
        case '--help':
        case '-h':
            console.log(USAGE);
            return;
        default:
            console.error(kleur.red(`Unknown command '${command}'`));
            console.log(USAGE);
            process.exitCode = 1;
    }
}

async function interactive() {
    console.log(kleur.bold().green('Brumescape Modding Tool'));

    const action = await select({
        message: 'What would you like to do?',
        choices: [
            { name: 'Create new mod', value: 'create', description: 'Scaffold a new mod directory' },
            { name: 'List mods', value: 'list', description: 'List installed mods in load order' },
            { name: 'Enable or disable a mod', value: 'toggle', description: 'Edit mods.json' },
            { name: 'Exit', value: 'exit' }
        ]
    });

    switch (action) {
        case 'create':
            await createMod();
            break;
        case 'list':
            listMods();
            break;
        case 'toggle': {
            const installed = findInstalledMods(MODS_DIR);
            if (installed.length === 0) {
                console.log(kleur.yellow('No mods found.'));
                return;
            }
            const disabled = new Set(readModsConfig(MODS_DIR).disabled);
            const name = await select({
                message: 'Which mod?',
                choices: installed.map(m => ({ name: `${m.name} (${disabled.has(m.name) ? 'disabled' : 'enabled'})`, value: m.name }))
            });
            setEnabled(name, disabled.has(name));
            break;
        }
        case 'exit':
            process.exit(0);
    }
}

async function createMod() {
    const modName = await input({
        message: 'Enter mod name (folder safe):',
        validate: value => (/^[A-Za-z0-9_.-]+$/.test(value) ? true : "Invalid name. Use letters, digits, '_', '-' or '.'.")
    });

    const modPath = path.join(MODS_DIR, modName);
    if (fs.existsSync(modPath)) {
        console.error(kleur.red(`Mod '${modName}' already exists!`));
        return;
    }

    const description = await input({ message: 'Mod description:' });
    const version = await input({ message: 'Mod version:', default: '1.0.0' });
    const author = await input({ message: 'Author:' });

    console.log(kleur.yellow(`Creating mod at ${modPath}...`));

    fs.mkdirSync(modPath, { recursive: true });
    for (const dir of ['config', 'scripts']) {
        fs.mkdirSync(path.join(modPath, dir));
    }

    const manifest = {
        name: modName,
        description,
        version,
        author,
        dependencies: {}
    };
    fs.writeFileSync(path.join(modPath, 'mod.json'), JSON.stringify(manifest, null, 4) + '\n');

    console.log(kleur.green(`Mod '${modName}' created successfully!`));
}

function listMods() {
    let result;
    try {
        result = discoverMods(MODS_DIR);
    } catch (err) {
        console.error(kleur.red(`Cannot resolve mods: ${err instanceof Error ? err.message : err}`));
        process.exitCode = 1;
        return;
    }

    for (const warning of result.warnings) {
        console.log(kleur.yellow(warning));
    }

    if (result.mods.length === 0 && result.disabled.length === 0) {
        console.log(kleur.yellow('No mods found.'));
        return;
    }

    console.log(kleur.bold('Enabled mods, in load order:'));
    result.mods.forEach((mod, i) => {
        const deps = Object.keys(mod.manifest.dependencies ?? {});
        console.log(`  ${i + 1}. ${kleur.cyan(mod.name)} v${mod.manifest.version}${mod.manifest.author ? ` by ${mod.manifest.author}` : ''}${deps.length ? kleur.gray(` (depends on ${deps.join(', ')})`) : ''}`);
    });

    if (result.disabled.length > 0) {
        console.log(kleur.bold('Disabled (mods.json):'));
        for (const mod of result.disabled) {
            console.log(`  - ${kleur.gray(mod.name)}`);
        }
    }
}

function setEnabled(name: string | undefined, enabled: boolean) {
    if (!name) {
        console.error(kleur.red(`Usage: bun run mod ${enabled ? 'enable' : 'disable'} <name>`));
        process.exitCode = 1;
        return;
    }

    const installed = findInstalledMods(MODS_DIR);
    if (!installed.some(m => m.name === name)) {
        console.error(kleur.red(`No installed mod is named '${name}'. Installed: ${installed.map(m => m.name).join(', ') || '(none)'}`));
        process.exitCode = 1;
        return;
    }

    const config = readModsConfig(MODS_DIR);
    const disabled = new Set(config.disabled);
    if (enabled) {
        disabled.delete(name);
    } else {
        disabled.add(name);
    }
    writeModsConfig(MODS_DIR, { disabled: Array.from(disabled) });
    console.log(kleur.green(`${name} ${enabled ? 'enabled' : 'disabled'}. Rebuild to apply (bun run build).`));
}

main().catch(err => {
    console.error(kleur.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
});
