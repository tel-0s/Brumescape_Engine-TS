// ============================================================================
// MOD CAPABILITY REGISTRATION POINT (append-only)
//
// Each capability is one module in this directory that default-exports a
// ModCapability (see src/mod/ModTypes.ts and src/mod/README.md). Register it
// here with ONE line. Within each hook point, capabilities run in the order
// they are registered below.
//
// To keep parallel branches mergeable, each capability area has its own slot.
// Add your line(s) directly under your slot's comment and leave the blank line
// and the next slot's comment untouched.
// ============================================================================

import ModManager from '#/mod/ModManager.js';

// ---- core: configs, assets, scripts, world placement ----
ModManager.register((await import('#/mod/capabilities/configs.js')).default);
ModManager.register((await import('#/mod/capabilities/models.js')).default);
ModManager.register((await import('#/mod/capabilities/textures.js')).default);
ModManager.register((await import('#/mod/capabilities/title.js')).default);
ModManager.register((await import('#/mod/capabilities/scripts.js')).default);
ModManager.register((await import('#/mod/capabilities/spawns.js')).default);
ModManager.register((await import('#/mod/capabilities/init.js')).default);

// ---- slot A: script overrides and partial config patching ----
ModManager.register((await import('#/mod/capabilities/script-overrides.js')).default);

// ---- slot B: interfaces (.if) and sprites ----

// ---- slot C: animations (.anim frames/bases) and model authoring ----

// ---- slot D: maps and new lands (.jm2, obj spawns) ----

// ---- slot E: data types (.constant, .dbtable/.dbrow, .flo, categories) and audio ----
ModManager.register((await import('#/mod/capabilities/data.js')).default);
ModManager.register((await import('#/mod/capabilities/audio.js')).default);

// ---- (end of registration point) ----
