// Capability: audio.
//
// Mod layout:
//   synth/**/*.synth    sound effects (raw wave data, same format as base synth/)
//   songs/**/*.mid      songs   (MIDI files, played with midi_song("name"))
//   jingles/**/*.mid    jingles (MIDI files, played with midi_jingle("name", ticks))
//
// The file name (without extension) is the asset name. A new name gets a stable
// id after the base ids; a base name replaces the base file and keeps its id.
// Synth names are compiler symbols (sound_synth(my_sound, 1, 0)). Songs and
// jingles share one id space (the midi pack) and are looked up by name at
// runtime, so the server registers mod names in worldBoot.

import fs from 'fs';

import ModManager from '#/mod/ModManager.js';
import type { ModCapability, ModFile } from '#/mod/ModTypes.js';
import { validateSynthFile } from '#/mod/SynthFormat.js';
import { printInfo } from '#/util/Logger.js';
import { MidiPack, SynthPack } from '#tools/pack/PackFile.js';

const SYNTH_NAME = /^[a-z0-9_]+$/;
const SONG_NAME = /^[a-z0-9_-]+$/;
// base jingles have spaces in their names, e.g. "advance cooking"
const JINGLE_NAME = /^[a-z0-9_ -]+$/;

// Where a mod name was defined, so duplicates in one mod are an error
function checkSameMod(kind: string, name: string, file: ModFile, seen: Map<string, ModFile>) {
    const first = seen.get(name);
    if (first && first.mod === file.mod) {
        throw ModManager.error(file, null, `${kind} '${name}' is defined twice in this mod (also ${first.relPath})`);
    }
    seen.set(name, file);
}

const capability: ModCapability = {
    name: 'audio',

    afterRevalidate() {
        const synths = new Map<string, ModFile>();
        for (const file of ModManager.listFiles('synth', '.synth')) {
            if (!SYNTH_NAME.test(file.name)) {
                throw ModManager.error(file, null, `Invalid synth name '${file.name}' (use lowercase letters, digits and underscores)`);
            }
            checkSameMod('synth', file.name, file, synths);

            try {
                validateSynthFile(fs.readFileSync(file.path));
            } catch (err) {
                throw ModManager.error(file, null, `Not a valid synth wave: ${err instanceof Error ? err.message : err}`);
            }

            if (ModManager.isBaseName(SynthPack, file.name)) {
                printInfo(`[mods] ${file.mod.name} replaces base synth ${file.name}`);
            }
            ModManager.claim('synth', file.name, file);
            ModManager.registerName('synth', SynthPack, file.name);
            ModManager.setAsset('synth', file.name, file.path);
            ModManager.markTouched('.synth');
        }

        const midis = new Map<string, ModFile>();
        const kinds: [string, string, RegExp][] = [
            ['songs', 'song', SONG_NAME],
            ['jingles', 'jingle', JINGLE_NAME]
        ];
        for (const [dir, kind, pattern] of kinds) {
            for (const file of ModManager.listFiles(dir, '.mid')) {
                if (!pattern.test(file.name)) {
                    throw ModManager.error(file, null, `Invalid ${kind} name '${file.name}' (the name must be lowercase and use only ${kind === 'song' ? 'letters, digits, _ and -' : 'letters, digits, spaces, _ and -'}, or midi_${kind} cannot find it)`);
                }
                checkSameMod('song/jingle', file.name, file, midis);

                const data = fs.readFileSync(file.path);
                if (data.length < 14 || data.subarray(0, 4).toString('latin1') !== 'MThd') {
                    throw ModManager.error(file, null, 'Not a MIDI file (it must start with an MThd header and be non-empty)');
                }

                if (ModManager.isBaseName(MidiPack, file.name)) {
                    printInfo(`[mods] ${file.mod.name} replaces base ${kind} ${file.name}`);
                }
                ModManager.claim('midi', file.name, file);
                ModManager.registerName('midi', MidiPack, file.name);
                ModManager.setAsset('midi', file.name, file.path);
                ModManager.setAsset('midikind', file.name, kind);
            }
        }
    },

    // midi_song / midi_jingle look names up in MidiPack inside the server
    // process, which only loads base names. Register the mod names again here
    // (their ids come from idmap.json, so they match the packed cache).
    worldBoot() {
        for (const file of ModManager.listFiles('songs', '.mid')) {
            ModManager.registerName('midi', MidiPack, file.name);
        }
        for (const file of ModManager.listFiles('jingles', '.mid')) {
            ModManager.registerName('midi', MidiPack, file.name);
        }
    }
};

export default capability;
