import fs from 'fs';
import path from 'path';
import { select, input } from '@inquirer/prompts';
import kleur from 'kleur';

const MODS_DIR = 'mods';

async function main() {
    console.log(kleur.bold().green('Brumescape Modding Tool'));

    if (!fs.existsSync(MODS_DIR)) {
        fs.mkdirSync(MODS_DIR);
    }

    const action = await select({
        message: 'What would you like to do?',
        choices: [
            {
                name: 'Create new mod',
                value: 'create',
                description: 'Scaffold a new mod directory'
            },
            {
                name: 'List mods',
                value: 'list',
                description: 'List installed mods'
            },
            {
                name: 'Exit',
                value: 'exit'
            }
        ],
    });

    switch (action) {
        case 'create':
            await createMod();
            break;
        case 'list':
            await listMods();
            break;
        case 'exit':
            process.exit(0);
    }
}

async function createMod() {
    const modName = await input({
        message: 'Enter mod name (folder safe):',
        validate: (value) => /^[a-z0-9-_]+$/i.test(value) ? true : 'Invalid name. Use alphanumeric, hyphens, or underscores.'
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
    
    // Create structure
    const dirs = ['scripts', 'models', 'sprites', 'maps', 'config'];
    for (const dir of dirs) {
        fs.mkdirSync(path.join(modPath, dir));
    }

    // Create mod.json
    const modConfig = {
        name: modName,
        description,
        version,
        author,
        dependencies: {}
    };

    fs.writeFileSync(path.join(modPath, 'mod.json'), JSON.stringify(modConfig, null, 2));

    console.log(kleur.green(`Mod '${modName}' created successfully!`));
}

async function listMods() {
    const mods = fs.readdirSync(MODS_DIR).filter(file => {
        return fs.statSync(path.join(MODS_DIR, file)).isDirectory() && fs.existsSync(path.join(MODS_DIR, file, 'mod.json'));
    });

    if (mods.length === 0) {
        console.log(kleur.yellow('No mods found.'));
        return;
    }

    console.log(kleur.bold('Installed Mods:'));
    for (const modDir of mods) {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(MODS_DIR, modDir, 'mod.json'), 'utf-8'));
            console.log(`- ${kleur.cyan(config.name)} v${config.version} by ${config.author}`);
        } catch (e) {
            console.log(`- ${kleur.red(modDir)} (Invalid mod.json)`);
        }
    }
}

main().catch(console.error);

