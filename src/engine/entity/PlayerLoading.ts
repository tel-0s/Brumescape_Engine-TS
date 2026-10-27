import 'dotenv/config';

import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { NetworkPlayer } from '#/engine/entity/NetworkPlayer.js';
import Player, { getExpByLevel, getLevelByExp } from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import World from '#/engine/World.js';
import Packet from '#/io/Packet.js';
import ClientSocket from '#/server/ClientSocket.js';
import { fromBase37, toBase37 } from '#/util/JString.js';

// Saved data that this build has no config for: it belongs to a mod that is
// disabled or removed (its ids stay reserved in mods/idmap.json). The player
// keeps it out of the game, and Player.save() writes it back unchanged, so it
// returns when the mod is enabled again.
export interface HeldObj {
    slot: number;
    id: number;
    count: number;
}

export interface HeldInv {
    // slot count of the saved inventory
    size: number;
    objs: HeldObj[];
}

export class PlayerLoading {
    public static readonly SAV_MAGIC: number = 0x2004;
    public static readonly SAV_VERSION: number = 6;

    static verify(sav: Packet) {
        if (sav.g2() !== PlayerLoading.SAV_MAGIC) {
            return false;
        }

        const version = sav.g2();
        if (version > PlayerLoading.SAV_VERSION) {
            return false;
        }

        sav.pos = sav.data.length - 4;
        const crc = sav.g4s();
        return crc === Packet.getcrc(sav.data, 0, sav.data.length - 4);
    }

    // Whether this build defines a config id. An id past the end, or a gap
    // (an id kept for a disabled or removed mod, packed without a name), is
    // unknown.
    static isKnownVarp(id: number): boolean {
        return !!VarPlayerType.get(id)?.debugname;
    }

    static isKnownInv(id: number): boolean {
        return !!InvType.get(id)?.debugname;
    }

    static isKnownObj(id: number): boolean {
        return !!ObjType.get(id)?.debugname;
    }

    static load(name: string, sav: Packet, client: ClientSocket | null) {
        const hash64 = toBase37(name); // username or email.
        const name37 = toBase37(name); // always username.
        const safeName = fromBase37(name37); // always safe username.

        const player = client ? new NetworkPlayer(safeName, name37, hash64, client) : new Player(safeName, name37, hash64);

        player.lastConnected = World.currentTick;
        player.lastResponse = World.currentTick;

        if (sav.data.length < 2) {
            for (let i = 0; i < 21; i++) {
                player.stats[i] = 0;
                player.baseLevels[i] = 1;
                player.levels[i] = 1;
            }

            // hitpoints starts at level 10
            player.stats[PlayerStat.HITPOINTS] = getExpByLevel(10);
            player.baseLevels[PlayerStat.HITPOINTS] = 10;
            player.levels[PlayerStat.HITPOINTS] = 10;
            return player;
        }

        if (sav.g2() !== PlayerLoading.SAV_MAGIC) {
            throw new Error('Invalid save file');
        }

        const version = sav.g2();
        if (version > PlayerLoading.SAV_VERSION) {
            throw new Error('Unsupported save version');
        }

        sav.pos = sav.data.length - 4;
        const crc = sav.g4s();
        if (crc != Packet.getcrc(sav.data, 0, sav.data.length - 4)) {
            throw new Error('Incorrect save checksum');
        }

        sav.pos = 4;
        player.x = sav.g2();
        player.z = sav.g2();
        player.level = sav.g1();
        for (let i = 0; i < 7; i++) {
            player.body[i] = sav.g1();
            if (player.body[i] === 255) {
                player.body[i] = -1;
            }
        }
        for (let i = 0; i < 5; i++) {
            player.colors[i] = sav.g1();
        }
        player.gender = sav.g1();
        player.runenergy = sav.g2();
        if (version >= 2) {
            // oops playtime overflow
            player.playtime = sav.g4s();
        } else {
            player.playtime = sav.g2();
        }

        for (let i = 0; i < 21; i++) {
            player.stats[i] = sav.g4s();
            player.baseLevels[i] = getLevelByExp(player.stats[i]);
            player.levels[i] = sav.g1();
        }

        const varpCount = sav.g2();
        for (let i = 0; i < varpCount; i++) {
            const value = sav.g4s();
            if (PlayerLoading.isKnownVarp(i)) {
                player.vars[i] = value;
            } else if (value !== 0) {
                // a varp of a disabled or removed mod (save() writes it back)
                player.heldVars.set(i, value);
            }
        }

        // objs of known types that come back into the game from slots past an
        // inventory's last slot (see Player.save), placed after every
        // inventory is loaded
        const returning: { type: number; obj: HeldObj }[] = [];

        const invCount = sav.g1();
        for (let i = 0; i < invCount; i++) {
            const type = sav.g2();
            const invType: InvType | undefined = InvType.get(type);
            const known = PlayerLoading.isKnownInv(type);
            if (!known && version < 5) {
                throw new Error(`Save has inventory type ${type}, which this build does not define, and a version ${version} save does not store its size`);
            }
            const size = version >= 5 ? sav.g2() : invType!.size;

            const objs: HeldObj[] = [];
            for (let slot = 0; slot < size; slot++) {
                const id = sav.g2() - 1;
                if (id === -1) {
                    continue;
                }

                let count = sav.g1();
                if (count === 255) {
                    count = sav.g4s();
                }

                objs.push({ slot, id, count });
            }

            if (!known) {
                // an inventory of a disabled or removed mod (save() writes it back)
                player.heldInvs.set(type, { size, objs });
                continue;
            }

            if (invType!.scope === InvType.SCOPE_PERM) {
                const inv = player.getInventory(type);
                if (inv) {
                    for (const obj of objs) {
                        if (!PlayerLoading.isKnownObj(obj.id)) {
                            // an obj of a disabled or removed mod keeps its slot
                            player.holdObj(type, obj);
                        } else if (obj.slot < inv.capacity && !inv.get(obj.slot)) {
                            inv.set(obj.slot, { id: obj.id, count: obj.count });
                        } else {
                            returning.push({ type, obj });
                        }
                    }
                }
            }
        }

        // Each returning obj goes to the first free slot that no held obj
        // keeps. A worn obj goes to the backpack (a worn slot is a body
        // part). With no free slot it stays held.
        for (const { type, obj } of returning) {
            const target = type === InvType.WORN && InvType.INV !== -1 ? InvType.INV : type;
            const inv = player.getInventory(target);
            const slot = inv ? player.freeUnheldSlot(target, inv) : -1;
            if (inv && slot !== -1) {
                inv.set(slot, { id: obj.id, count: obj.count });
            } else {
                player.holdObj(type, obj);
            }
        }

        // afk zones
        if (version >= 3) {
            const afkZones: number = sav.g1();
            for (let index: number = 0; index < afkZones; index++) {
                player.afkZones[index] = sav.g4s();
            }
            player.lastAfkZone = sav.g2();
        }

        // chat modes
        if (version >= 4) {
            const packedChatModes = sav.g1();
            player.publicChat = (packedChatModes >> 4) & 0b11;
            player.privateChat = (packedChatModes >> 2) & 0b11;
            player.tradeDuel = packedChatModes & 0b11;
        }

        // last login info
        if (version >= 6) {
            player.lastDate = sav.g8();
        }

        player.combatLevel = player.getCombatLevel();

        return player;
    }
}
