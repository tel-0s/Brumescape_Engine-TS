import child_process from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { select, input } from '@inquirer/prompts';
import kleur from 'kleur';

import { discoverMods, findInstalledMods, readModsConfig, writeModsConfig } from '#/mod/ModDiscovery.js';
import type { Mod, ModManifest } from '#/mod/ModTypes.js';
import Environment from '#/util/Environment.js';
import { MAP_USAGE, mapCommand } from '#tools/mod/MapTool.js';

const MODS_DIR = Environment.BUILD_MODS_DIR;

const USAGE = `Usage: bun run mod [command]

Works on the mods dir in BUILD_MODS_DIR (default: mods). The full guide is MODDING.md.

Mods:
  (none)            interactive menu
  list              show installed mods in load order, and disabled mods
  create [<name>] [--author <a>] [--description <d>] [--version <v>]
                    scaffold a new mod: mod.json, every folder, spawns.json and a
                    starter script (asks for anything not given when run without <name>)
  enable <name>     enable a mod (removes it from mods.json "disabled")
  disable <name>    disable a mod without deleting it (adds it to mods.json "disabled")
  validate <name>   build base content plus only this mod and its dependencies, to
                    check it on its own (uses a copy of idmap.json; leaves data/pack
                    holding that build, so run bun run build afterwards)

Maps:
${MAP_USAGE}

Tools (the same as the bun run scripts named in brackets):
  art <command>     models from OBJ, animation sets      [bun run mod:art]
  inspect <command> read back the last build             [bun run mod:inspect]
  ui <command>      decoded interfaces and media sprites [bun tools/mod/InspectInterfaces.ts]
                    Run any of them without a command for its own help.`;

// Folders that capabilities read, with what goes in them (see MODDING.md).
// The scaffold creates all of them.
const MOD_FOLDERS: [string, string][] = [
    ['config', 'configs: .npc .obj .loc .seq .spotanim .idk .enum .struct .hunt .mesanim .varp .varn .vars .param .inv .dbtable .dbrow .flo .constant'],
    ['config/patch', 'config patches: change some properties of an existing config'],
    ['scripts', 'RuneScript (.rs2): new scripts and overrides of existing ones'],
    ['interfaces', 'interfaces: new or replaced .if files, .ifpatch changes'],
    ['sprites', 'sprites (.png, optional meta/<name>.opt) for the media archive'],
    ['models', 'models: .ob2, or .obj + .mtl (+ optional <name>.json)'],
    ['textures', 'textures (.png, optional meta/<name>.opt)'],
    ['anims', 'animation sets (<set>.json)'],
    ['maps', 'map squares (m<x>_<z>.jm2, m<x>_<z>.patch.jm2) and free2play.csv / multiway.csv'],
    ['synth', 'sound effects (.synth)'],
    ['songs', 'songs (.mid)'],
    ['jingles', 'jingles (.mid)'],
    ['title', 'title screen sprites: logo.png runes.png titlebox.png titlebutton.png'],
    ['binary', 'title screen background: title.jpg']
];

async function main() {
    const [command, ...rest] = process.argv.slice(2);

    if (!fs.existsSync(MODS_DIR)) {
        fs.mkdirSync(MODS_DIR, { recursive: true });
    }

    switch (command) {
        case undefined:
            return interactive();
        case 'list':
            return listMods();
        case 'create':
            return createMod(rest);
        case 'enable':
        case 'disable':
            return setEnabled(rest[0], command === 'enable');
        case 'validate':
            return validateMod(rest[0]);
        case 'map':
            return mapCommand(rest);
        case 'art':
            return runTool('tools/mod/Art.ts', rest);
        case 'inspect':
            return runTool('tools/mod/Inspect.ts', rest);
        case 'ui':
            return runTool('tools/mod/InspectInterfaces.ts', rest);
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
            { name: 'Create new mod', value: 'create', description: 'Scaffold a new mod directory with every folder and starter files' },
            { name: 'List mods', value: 'list', description: 'List installed mods in load order' },
            { name: 'Enable or disable a mod', value: 'toggle', description: 'Edit mods.json' },
            { name: 'Validate a mod', value: 'validate', description: 'Build base content plus only one mod (and its dependencies)' },
            { name: 'Add a map square', value: 'map', description: 'New square, copy of a base square, or a patch (bun run mod map)' },
            { name: 'Show map squares in use', value: 'grid', description: 'bun run mod map grid' },
            { name: 'Help: all commands', value: 'help' },
            { name: 'Exit', value: 'exit' }
        ]
    });

    switch (action) {
        case 'create':
            await createMod([]);
            break;
        case 'list':
            listMods();
            break;
        case 'toggle': {
            const name = await pickMod('Which mod?');
            if (name) {
                const disabled = new Set(readModsConfig(MODS_DIR).disabled);
                setEnabled(name, disabled.has(name));
            }
            break;
        }
        case 'validate': {
            const name = await pickMod('Which mod?');
            if (name) {
                validateMod(name);
            }
            break;
        }
        case 'map': {
            const name = await pickMod('Which mod gets the square?');
            if (!name) {
                break;
            }
            const kind = await select({
                message: 'What kind of square?',
                choices: [
                    { name: 'A new square (map new)', value: 'new' },
                    { name: 'A copy of a base square, to replace it (map copy)', value: 'copy' },
                    { name: 'A patch of an existing square (map patch)', value: 'patch' }
                ]
            });
            const square = await input({
                message: 'Square (m<x>_<z>, e.g. m60_50):',
                validate: value => (/^m\d{1,3}_\d{1,3}$/.test(value) ? true : 'Write it as m<x>_<z>, e.g. m60_50')
            });
            await mapCommand([kind, name, square]);
            break;
        }
        case 'grid':
            await mapCommand(['grid']);
            break;
        case 'help':
            console.log(USAGE);
            break;
        case 'exit':
            process.exit(0);
    }
}

async function pickMod(message: string): Promise<string | null> {
    const installed = findInstalledMods(MODS_DIR);
    if (installed.length === 0) {
        console.log(kleur.yellow('No mods found.'));
        return null;
    }
    const disabled = new Set(readModsConfig(MODS_DIR).disabled);
    return select({
        message,
        choices: installed.map(m => ({ name: `${m.name} (${disabled.has(m.name) ? 'disabled' : 'enabled'})`, value: m.name }))
    });
}

// Pulls `--key value` options out of args; returns the remaining positional args.
function parseOptions(args: string[], keys: string[]): { options: Map<string, string>; positional: string[] } {
    const options = new Map<string, string>();
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const key = args[i].startsWith('--') ? args[i].slice(2) : null;
        if (key === null) {
            positional.push(args[i]);
            continue;
        }
        if (!keys.includes(key)) {
            throw new Error(`Unknown option --${key}. Options: ${keys.map(k => `--${k}`).join(', ')}`);
        }
        if (i + 1 >= args.length) {
            throw new Error(`--${key} needs a value`);
        }
        options.set(key, args[++i]);
    }
    return { options, positional };
}

// A RuneScript-safe identifier from a mod name: MyMod-2 -> mymod_2
function scriptId(modName: string): string {
    const id = modName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    return /^[a-z]/.test(id) ? id : `mod_${id}`;
}

async function createMod(args: string[]) {
    const { options, positional } = parseOptions(args, ['author', 'description', 'version']);
    const validName = (value: string) => (/^[A-Za-z0-9_.-]+$/.test(value) ? true : "Invalid name. Use letters, digits, '_', '-' or '.'.");

    let modName = positional[0];
    const interactive = modName === undefined;
    if (interactive) {
        modName = await input({ message: 'Enter mod name (folder safe):', validate: validName });
    } else if (validName(modName) !== true) {
        throw new Error(`Invalid mod name '${modName}'. Use letters, digits, '_', '-' or '.'.`);
    }

    const modPath = path.join(MODS_DIR, modName);
    if (fs.existsSync(modPath)) {
        console.error(kleur.red(`Mod '${modName}' already exists at ${modPath}`));
        process.exitCode = 1;
        return;
    }
    if (findInstalledMods(MODS_DIR).some(m => m.name === modName)) {
        console.error(kleur.red(`Another folder in ${MODS_DIR} already has a mod named '${modName}'`));
        process.exitCode = 1;
        return;
    }

    const description = options.get('description') ?? (interactive ? await input({ message: 'Mod description:' }) : '');
    const version = options.get('version') ?? (interactive ? await input({ message: 'Mod version:', default: '1.0.0' }) : '1.0.0');
    const author = options.get('author') ?? (interactive ? await input({ message: 'Author:' }) : '');
    const id = scriptId(modName);

    console.log(kleur.yellow(`Creating mod at ${modPath}...`));

    fs.mkdirSync(modPath, { recursive: true });
    for (const [dir] of MOD_FOLDERS) {
        fs.mkdirSync(path.join(modPath, dir), { recursive: true });
    }

    // every field mod.json supports (see MODDING.md, "mod.json")
    const manifest: Required<ModManifest> = {
        name: modName,
        version,
        author,
        description,
        dependencies: {},
        init: `${id}_init`
    };
    fs.writeFileSync(path.join(modPath, 'mod.json'), JSON.stringify(manifest, null, 4) + '\n');

    // npcs, locs and objs placed when the server starts. Entries look like
    // { "id": "man", "coord": "0_50_50_32_32" } (see MODDING.md, "spawns.json").
    fs.writeFileSync(path.join(modPath, 'spawns.json'), JSON.stringify({ npcs: [], locs: [], objs: [] }, null, 4) + '\n');

    fs.writeFileSync(
        path.join(modPath, 'scripts', `${id}.rs2`),
        [
            `// ${modName}: starter script. The full guide is MODDING.md in the engine.`,
            '',
            '// Runs every time the server starts, after the map loads (mod.json "init").',
            '// There is no player here: use it for world setup, or delete it together',
            '// with the "init" line in mod.json.',
            `[proc,${id}_init]`,
            'def_int $unused = 0;',
            '',
            `// In game: ::~${id} (debugprocs run with ::~<name> when NODE_PRODUCTION is false)`,
            `[debugproc,${id}]`,
            `mes("${modName} is installed.");`,
            ''
        ].join('\n')
    );

    fs.writeFileSync(
        path.join(modPath, 'README.md'),
        [
            `# ${modName}`,
            '',
            description || 'A Brumescape mod.',
            '',
            'Folders (all optional; delete the ones you do not use). The full guide is',
            "`MODDING.md` in the engine's root folder.",
            '',
            '| Folder | Contents |',
            '| --- | --- |',
            ...MOD_FOLDERS.map(([dir, what]) => `| \`${dir}/\` | ${what} |`),
            '| `spawns.json` | npcs, locs and objs placed when the server starts |',
            '',
            'Build and check:',
            '',
            '```sh',
            `bun run mod validate ${modName}   # base content plus only this mod`,
            'bun run build                     # everything',
            '```',
            ''
        ].join('\n')
    );

    console.log(kleur.green(`Mod '${modName}' created.`));
    console.log(`  ${modPath}/mod.json, spawns.json, README.md, scripts/${id}.rs2`);
    console.log(`  folders: ${MOD_FOLDERS.map(([dir]) => dir).join(', ')}`);
    console.log(`Next: bun run mod validate ${modName}`);
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
    console.log(kleur.green(`${name} ${enabled ? 'enabled' : 'disabled'}. Rebuild to apply (bun run build), then restart the server.`));
    if (!enabled) {
        console.log(
            kleur.yellow(
                `While ${name} is disabled, its npcs, locs, maps, interfaces and scripts are gone, and script overrides return to base content.\n` +
                    'Players keep its saved varps and items: the server holds them out of the game and saves them back, and they return when it is enabled again.\n' +
                    'Keep its ids in idmap.json. See MODDING.md, "Disabling or removing a mod that players have used".'
            )
        );
    }
}

// Builds base content plus one mod and its dependencies, from a temporary mods
// dir. idmap.json is copied in, so ids match the real build; the copy is
// discarded, so validating never changes mods/idmap.json.
function validateMod(name: string | undefined) {
    if (!name) {
        console.error(kleur.red('Usage: bun run mod validate <name>'));
        process.exitCode = 1;
        return;
    }

    const installed = new Map(findInstalledMods(MODS_DIR).map(m => [m.name, m]));
    if (!installed.has(name)) {
        console.error(kleur.red(`No installed mod is named '${name}'. Installed: ${Array.from(installed.keys()).join(', ') || '(none)'}`));
        process.exitCode = 1;
        return;
    }

    // the mod and its dependencies, transitively
    const included = new Map<string, Mod>();
    const visit = (modName: string, from: string | null) => {
        if (included.has(modName)) {
            return;
        }
        const mod = installed.get(modName);
        if (!mod) {
            throw new Error(`${from} depends on '${modName}', which is not installed in ${MODS_DIR}`);
        }
        included.set(modName, mod);
        for (const dep of Object.keys(mod.manifest.dependencies ?? {})) {
            visit(dep, modName);
        }
    };
    visit(name, null);

    const disabled = readModsConfig(MODS_DIR).disabled.filter(n => included.has(n));
    if (disabled.length > 0) {
        console.log(kleur.yellow(`Note: ${disabled.join(', ')} ${disabled.length === 1 ? 'is' : 'are'} disabled in mods.json; validating anyway.`));
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brumescape-validate-'));
    try {
        for (const mod of included.values()) {
            fs.cpSync(mod.dir, path.join(tempDir, path.basename(mod.dir)), { recursive: true });
        }
        const idmap = path.join(MODS_DIR, 'idmap.json');
        if (fs.existsSync(idmap)) {
            fs.copyFileSync(idmap, path.join(tempDir, 'idmap.json'));
        }

        const others = Array.from(included.keys()).filter(n => n !== name);
        console.log(kleur.bold(`Validating ${name}${others.length ? ` (with its dependencies: ${others.join(', ')})` : ''}...`));

        const result = child_process.spawnSync('bun', ['run', 'tools/pack/Build.ts'], {
            env: { ...process.env, BUILD_MODS_DIR: tempDir, BUILD_STARTUP_UPDATE: 'false' },
            stdio: 'inherit'
        });

        if (result.status === 0) {
            console.log(kleur.green(`\n${name} builds with base content${others.length ? ' and its dependencies' : ''}.`));
        } else {
            console.log(kleur.red(`\n${name} does not build: see the first error above.`));
            process.exitCode = 1;
        }
        console.log(kleur.gray('data/pack now holds this validation build. Run `bun run build` to build every enabled mod again.'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

// Runs another mod tool with the same arguments
function runTool(script: string, args: string[]) {
    const result = child_process.spawnSync('bun', ['run', script, ...args], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
}

main().catch(err => {
    console.error(kleur.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
});
