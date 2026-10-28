// Checks for the interfaces fixture (run by `bun run mod:fixture interfaces`).
// Decodes the packed client interface archive and media archive with the
// engine's decoders (tools/mod/InspectInterfaces.ts).
import fs from 'fs';
import path from 'path';

import Component from '#/cache/config/Component.js';
import { discoverMods } from '#/mod/ModDiscovery.js';
import Environment from '#/util/Environment.js';
import { expect, readBasePack, readCompiledScripts, readIdMap, readJagEntry, readSymbols } from '#tools/mod/Inspect.js';
import { children, firstColour, getComponent, interfaceComponents, readSprite, readSpriteTiles } from '#tools/mod/InspectInterfaces.js';

const fixture = Environment.BUILD_MODS_DIR;
const ids = readIdMap(fixture).interface ?? {};
const base = readBasePack('interface');

function com(name: string): Component {
    const found = getComponent(name);
    if (!found) {
        throw new Error(`check failed: ${name} is not in the packed interfaces`);
    }
    return found;
}

function childAt(layer: string, child: string) {
    return children(com(layer)).find(c => c.name === child);
}

const order = discoverMods(fixture).mods.map(m => m.name);
expect(order.join(',') === 'if_base,if_addon', `load order is if_base, if_addon (got ${order.join(', ')})`);

// ---- a new interface with stable ids after base content
const journal = com('if_journal');
expect(journal.id === ids.if_journal && journal.id >= Math.max(...base.values()) + 1, `if_journal has its idmap id ${ids.if_journal}, after base content`);
expect(interfaceComponents('if_journal').length === 10, 'if_journal has its root and 9 components in the archive');
for (const name of ['background', 'frame', 'title', 'line1', 'line2', 'line3', 'badge', 'ok', 'icon']) {
    const c = com(`if_journal:${name}`);
    expect(c.id === ids[`if_journal:${name}`] && c.rootLayer === journal.id, `if_journal:${name} has its idmap id and belongs to if_journal`);
}
expect(
    children(journal)
        .map(c => c.name)
        .join(',') === 'if_journal:background,if_journal:frame,if_journal:badge,if_journal:ok,if_journal:icon',
    'if_journal root children in file order'
);
expect(com('if_journal:background').graphic === 'if_scroll,0', 'background uses the mod sprite if_scroll,0');
expect(com('if_journal:ok').activeGraphic === 'if_buttons,1' && com('if_journal:ok').option === 'Close journal' && com('if_journal:ok').buttonType === Component.BUTTON, 'ok button: sprite, option, button type');
expect(com('if_journal:icon').model === readBasePack('model').get('model_3042'), 'icon shows base model model_3042');
expect(com('if_journal:title').text === 'Fixture Journal' && com('if_journal:title').font === 3, 'title text and font q8');

// y=end+N stacking, including a component if_addon's patch appended
const frame = children(com('if_journal:frame'))
    .map(c => `${c.name.split(':')[1]}@${c.y}`)
    .join(',');
expect(frame === 'title@0,line1@24,line2@40,line3@56', `frame children stack with y=end+N (${frame})`);
expect(com('if_journal:frame').scroll === 200, 'frame scroll stays 200 (its content fits)');

// ---- if_addon patches if_base's interface
expect(com('if_journal:title').colour === 0x000080, 'if_addon recoloured if_journal:title');
expect(com('if_journal:line3').text === 'Added by if_addon', 'if_addon added if_journal:line3');

// ---- quest list: two mods append members' entries (y=end+2) and insert
// free entries (y=before:/after:) without knowing about each other.
// Order of operations: if_base appends if_quest (903, scroll 926), inserts
// if_free_quest before fortress (+16 from y 23 down, scroll 942); if_addon
// appends if_quest2 (935, scroll 958), inserts if_free_quest2 after hetty
// (+16 from y 319 down, scroll 974).
const questlist = com('questlist');
expect(questlist.id === base.get('questlist'), 'questlist keeps its base id');
const at = (name: string) => childAt('questlist:com_0', `questlist:${name}`)?.y;
expect(at('com_24') === 8, `the FREE QUESTS heading stays at 8 (got ${at('com_24')})`);
expect(at('if_free_quest') === 23 && at('fortress') === 39 && at('cook') === 55, `if_free_quest takes fortress's place, fortress and cook move down 16 (got ${at('if_free_quest')}, ${at('fortress')}, ${at('cook')})`);
expect(at('hetty') === 303 && at('if_free_quest2') === 319, `if_free_quest2 sits 2 px below hetty (hetty ${at('hetty')}, if_free_quest2 ${at('if_free_quest2')})`);
expect(at('com_43') === 338, `the MEMBERS QUESTS heading moved down 32 (306 -> ${at('com_43')})`);
expect(at('ball') === 919 && com('questlist:ball').text === 'Witches House', `the last base entry moved down 32 (887 -> ${at('ball')})`);
expect(at('if_quest') === 935, `if_quest (y=end+2) moved down with the list (y=${at('if_quest')}, want 935)`);
expect(at('if_quest2') === 951, `if_quest2 (y=end+2) sits below if_quest (y=${at('if_quest2')}, want 951)`);
expect(com('questlist:com_0').scroll === 974, `quest list scroll grew from 910 to 974 (got ${com('questlist:com_0').scroll})`);
expect(childAt('questlist:com_0', 'questlist:if_quest')?.x === 10, 'if_quest x is 10');
expect(com('questlist:if_quest').id === ids['questlist:if_quest'] && com('questlist:if_quest').rootLayer === questlist.id, 'if_quest has its idmap id and belongs to questlist');
expect(com('questlist:if_quest').text === 'Fixture Quest' && com('questlist:if_quest').buttonType === Component.BUTTON, 'if_quest is a clickable text entry');
expect(com('questlist:if_free_quest').text === 'A Fixture Quest' && com('questlist:if_free_quest2').text === 'Zany Fixture Quest', 'inserted entries have their text');
expect(com('questlist:com_1').text === 'Quest Journal (modded)', 'patched questlist:com_1 text');
expect(children(com('questlist:com_0')).length === 61, 'quest list layer has the 57 base children plus 4');

// ---- a base interface replaced by a mod
const map = com('misthalin_map');
expect(map.id === base.get('misthalin_map'), 'misthalin_map keeps its base id');
expect(com('misthalin_map:com_0').text === 'Misthalin (modded)' && com('misthalin_map:com_0').id === base.get('misthalin_map:com_0'), 'misthalin_map:com_0 is the mod version with its base id');
expect(com('misthalin_map:if_note').graphic === 'if_badge,0' && com('misthalin_map:if_note').id === ids['misthalin_map:if_note'], 'misthalin_map:if_note is new');
for (const name of ['com_1', 'com_2', 'com_3']) {
    const c = com(`misthalin_map:${name}`);
    expect(c.id === base.get(`misthalin_map:${name}`) && c.comType === Component.TYPE_LAYER && c.hide && c.width === 0 && c.height === 0 && c.childId?.length === 0, `left-out misthalin_map:${name} is an empty hidden layer with its base id`);
}

// ---- a replacement keeps the base interface's own properties it does not set
expect(com('music_ld').overlay && com('music_ld').id === base.get('music_ld'), 'music_ld replacement is still an overlay (type=overlay kept from base)');
expect(com('music_ld:if_tip').text === 'Music (modded)', 'music_ld:if_tip is the mod component');
expect(readSymbols('overlayinterface').has('music_ld'), 'music_ld stays in overlayinterface.sym');

// ---- two mods define the same new interface: the later one wins
const shared = com('if_shared');
expect(shared.overlay, "if_shared is if_addon's version (type=overlay)");
expect(com('if_shared:new_only').text === 'From if_addon', 'if_shared:new_only from if_addon');
expect(com('if_shared:old_only').comType === Component.TYPE_LAYER && com('if_shared:old_only').hide, "if_base's if_shared:old_only stays as a placeholder");

// ---- the archive count covers every id
const data = readJagEntry(3, 'data')!;
const count = (data[0] << 8) | data[1];
expect(count === Math.max(...Object.values(ids)) + 1, `interface archive count ${count} covers the highest mod id`);

// ---- compiler symbols and scripts
const iface = readSymbols('interface');
const component = readSymbols('component');
const overlay = readSymbols('overlayinterface');
expect(iface.get('if_journal') === ids.if_journal && iface.get('if_shared') === ids.if_shared, 'interface.sym has the mod interfaces');
expect(overlay.get('if_shared') === ids.if_shared && !overlay.has('if_journal'), 'overlayinterface.sym has if_shared only');
expect(component.get('questlist:if_quest') === ids['questlist:if_quest'] && component.get('if_journal:title') === ids['if_journal:title'], 'component.sym has the mod components');
expect(component.get('if_shared:old_only') === ids['if_shared:old_only'] && component.get('misthalin_map:com_1') === base.get('misthalin_map:com_1'), 'component.sym keeps left-out components');
const scripts = readCompiledScripts();
for (const name of ['[if_button,questlist:if_quest]', '[if_button,questlist:if_quest2]', '[if_button,if_journal:ok]', '[proc,if_fixture_open_journal]', '[proc,if_fixture_addon_ui]']) {
    expect(scripts.has(name), `${name} compiled`);
}

// ---- sprites (media archive)
const scroll = readSpriteTiles('if_scroll');
expect(scroll.length === 2, 'if_scroll has 2 tiles');
expect(scroll[0].width === 32 && scroll[0].cropLeft === 2 && scroll[0].cropTop === 4 && scroll[0].cropRight === 28 && scroll[0].cropBottom === 24 && firstColour(scroll[0]) === 0xd2b48c, 'if_scroll tile 0: generated crop 2,4 28x24, parchment colour');
expect(scroll[1].cropLeft === 8 && scroll[1].cropTop === 8 && scroll[1].cropRight === 16 && firstColour(scroll[1]) === 0xc00000, 'if_scroll tile 1: generated crop 8,8 16x16 on a magenta background');
const buttons = readSpriteTiles('if_buttons');
expect(buttons.length === 2 && buttons[1].cropLeft === 1 && buttons[1].cropRight === 14 && firstColour(buttons[1]) === 0x00a000, 'if_buttons uses its explicit crop boxes');
const badge = readSpriteTiles('if_badge');
expect(badge.length === 1 && badge[0].cropRight === 24 && firstColour(badge[0]) === 0x0000ff, "if_badge is if_addon's (24x24 blue), not if_base's");

const side = readSpriteTiles('sideicons');
expect(side.length === 13, `sideicons replacement has 13 tiles (got ${side.length})`);
for (let i = 0; i < 13; i++) {
    const t = side[i];
    expect(t.width === 30 && t.cropLeft === i % 5 && t.cropTop === i % 7 && t.cropRight === 10 + i && firstColour(t) === (((0x10 * i) << 16) | 0x8040), `sideicons tile ${i}: crop and colour of the mod image`);
}
const mapfunction = readSpriteTiles('mapfunction');
expect(mapfunction.length === 64 && mapfunction.every((t, i) => t.cropLeft === 2 && t.cropRight === 11 && firstColour(t) === (((i * 4) << 16) | 0x8020)), `mapfunction replacement has 64 tiles (base has 49), got ${mapfunction.length}`);
expect(readSprite('mapfunction', 64) === null, 'no tile past the last one');
expect(readSpriteTiles('headicons').length === 9, 'base sprites are still packed (headicons, 9 tiles)');

const staged = fs.readFileSync(path.resolve('data/pack/mods/sprites/meta/if_scroll.opt'), 'ascii');
expect(staged === '32x32\n2,4,28,24\n8,8,16,16\n', 'generated meta for if_scroll is staged under data/pack/mods/sprites');

// ---- nothing leaked into the content dir
const contentPack = fs.readFileSync(path.join(Environment.BUILD_SRC_DIR, 'pack', 'interface.pack'), 'utf-8');
expect(!/=(if_journal|if_shared|questlist:if_quest|misthalin_map:if_note)/.test(contentPack), 'no mod interface names in content/pack/interface.pack');
