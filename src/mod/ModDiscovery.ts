// Mod discovery and load order. Side-effect free (no tools/pack imports), so
// the mod CLI can use it without loading the packers.

import fs from 'fs';
import path from 'path';

import { Mod } from '#/mod/ModTypes.js';
import type { ModManifest } from '#/mod/ModTypes.js';

// <modsDir>/mods.json: local enable/disable switches. Missing file = all enabled.
//   { "disabled": ["SomeMod", "OtherMod"] }
export interface ModsConfig {
    disabled: string[];
}

export interface DiscoveryResult {
    // Enabled mods in load order
    mods: Mod[];
    // Installed but disabled through mods.json, sorted by name
    disabled: Mod[];
    // Non-fatal problems (e.g. unknown names in mods.json)
    warnings: string[];
}

const MOD_NAME = /^[A-Za-z0-9_.-]+$/;

export function modsConfigPath(modsDir: string): string {
    return path.join(modsDir, 'mods.json');
}

export function readModsConfig(modsDir: string): ModsConfig {
    const file = modsConfigPath(modsDir);
    if (!fs.existsSync(file)) {
        return { disabled: [] };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
        throw new Error(`${file}: invalid JSON: ${err instanceof Error ? err.message : err}`);
    }

    const disabled = (raw as { disabled?: unknown })?.disabled ?? [];
    if (!Array.isArray(disabled) || disabled.some(x => typeof x !== 'string')) {
        throw new Error(`${file}: "disabled" must be an array of mod names`);
    }
    return { disabled: disabled as string[] };
}

export function writeModsConfig(modsDir: string, config: ModsConfig) {
    const disabled = Array.from(new Set(config.disabled)).sort(compareNames);
    fs.writeFileSync(modsConfigPath(modsDir), JSON.stringify({ disabled }, null, 4) + '\n');
}

// Plain code-unit order, so the result does not depend on the locale
export function compareNames(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function readManifest(dir: string): ModManifest {
    const file = path.join(dir, 'mod.json');
    let manifest: ModManifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf-8')) as ModManifest;
    } catch (err) {
        throw new Error(`${file}: invalid JSON: ${err instanceof Error ? err.message : err}`);
    }

    if (typeof manifest !== 'object' || manifest === null) {
        throw new Error(`${file}: expected a JSON object`);
    }
    if (typeof manifest.name !== 'string' || !MOD_NAME.test(manifest.name)) {
        throw new Error(`${file}: "name" is required and may only contain letters, digits, '_', '-' and '.'`);
    }
    if (manifest.dependencies !== undefined && (typeof manifest.dependencies !== 'object' || manifest.dependencies === null || Array.isArray(manifest.dependencies))) {
        throw new Error(`${file}: "dependencies" must be an object of { "<mod name>": "<version>" }`);
    }
    if (manifest.init !== undefined && typeof manifest.init !== 'string') {
        throw new Error(`${file}: "init" must be a proc name`);
    }
    return manifest;
}

// Every <modsDir>/<dir>/mod.json. Throws on an invalid manifest or a
// duplicate mod name.
export function findInstalledMods(modsDir: string): Mod[] {
    if (!fs.existsSync(modsDir)) {
        return [];
    }

    const mods: Mod[] = [];
    const byName = new Map<string, Mod>();
    for (const entry of fs.readdirSync(modsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }

        const dir = path.resolve(modsDir, entry.name);
        if (!fs.existsSync(path.join(dir, 'mod.json'))) {
            continue;
        }

        const mod = new Mod(dir, readManifest(dir));
        const existing = byName.get(mod.name);
        if (existing) {
            throw new Error(`Two mods are named '${mod.name}': ${existing.dir} and ${mod.dir}`);
        }
        byName.set(mod.name, mod);
        mods.push(mod);
    }

    return mods.sort((a, b) => compareNames(a.name, b.name));
}

// Load order: mods sorted by name, then ordered so every mod comes after its
// dependencies (a stable topological sort: among mods whose dependencies are
// all placed, the one that sorts first by name goes next). Throws when a
// dependency is missing or disabled, or on a dependency cycle.
export function discoverMods(modsDir: string): DiscoveryResult {
    const installed = findInstalledMods(modsDir);
    const config = readModsConfig(modsDir);
    const warnings: string[] = [];

    const installedNames = new Set(installed.map(m => m.name));
    for (const name of config.disabled) {
        if (!installedNames.has(name)) {
            warnings.push(`${modsConfigPath(modsDir)}: disabled mod '${name}' is not installed`);
        }
    }

    const disabledNames = new Set(config.disabled);
    const enabled = installed.filter(m => !disabledNames.has(m.name));
    const disabled = installed.filter(m => disabledNames.has(m.name));
    const enabledByName = new Map(enabled.map(m => [m.name, m]));

    for (const mod of enabled) {
        for (const dep of Object.keys(mod.manifest.dependencies ?? {})) {
            if (dep === mod.name) {
                throw new Error(`Mod '${mod.name}' depends on itself`);
            }
            if (!enabledByName.has(dep)) {
                const why = installedNames.has(dep) ? 'which is disabled in mods.json' : 'which is not installed';
                throw new Error(`Mod '${mod.name}' depends on '${dep}', ${why}`);
            }
        }
    }

    const order: Mod[] = [];
    const placed = new Set<string>();
    const remaining = [...enabled]; // already sorted by name
    while (remaining.length > 0) {
        const next = remaining.findIndex(m => Object.keys(m.manifest.dependencies ?? {}).every(dep => placed.has(dep)));
        if (next === -1) {
            throw new Error(`Mod dependency cycle between: ${remaining.map(m => m.name).join(', ')}`);
        }
        const [mod] = remaining.splice(next, 1);
        order.push(mod);
        placed.add(mod.name);
    }

    return { mods: order, disabled, warnings };
}
