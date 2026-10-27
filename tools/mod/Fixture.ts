// Build the engine against a fixture mods dir and check the result.
//
//   bun run mod:fixture <name|path> [<name|path> ...]
//   bun run mod:fixture --all
//
// <name> is a directory under tools/mod/fixtures/. Each fixture is a mods dir
// (BUILD_MODS_DIR): mod folders with mod.json, plus optional files:
//   mods.json        enable/disable switches, as in mods/
//   check.ts         run after a successful build (same env); throw or exit
//                    non-zero to fail. Use the readers in tools/mod/Inspect.ts.
//   expect-fail.txt  the build must FAIL, and its output must contain every
//                    non-empty line of this file
//   seed-idmap.json  copied to idmap.json before every build, for fixed ids
//                    (e.g. an id kept for a disabled mod)
// The fixture's idmap.json is written inside the fixture dir (gitignored).
//
// The build writes data/pack like any build: run `bun run build` afterwards to
// get back to the real mods/.

import child_process from 'child_process';
import fs from 'fs';
import path from 'path';

const FIXTURES = 'tools/mod/fixtures';

function resolveFixture(arg: string): string {
    const named = path.join(FIXTURES, arg);
    if (fs.existsSync(named) && fs.statSync(named).isDirectory()) {
        return named;
    }
    if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
        return arg;
    }
    throw new Error(`No fixture '${arg}' (looked in ${named} and ${arg})`);
}

function run(command: string[], env: NodeJS.ProcessEnv, verbose: boolean): { status: number; output: string } {
    const result = child_process.spawnSync(command[0], command.slice(1), { env, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    for (const line of output.split('\n')) {
        // base content prints hundreds of these on every build
        if (verbose || !line.includes('missing model')) {
            console.log(line);
        }
    }
    return { status: result.status ?? 1, output };
}

function runFixture(dir: string, verbose: boolean): boolean {
    const name = path.basename(dir);
    console.log(`\n=== fixture ${name} (BUILD_MODS_DIR=${dir}) ===`);

    const seed = path.join(dir, 'seed-idmap.json');
    if (fs.existsSync(seed)) {
        fs.copyFileSync(seed, path.join(dir, 'idmap.json'));
    }

    const env = { ...process.env, BUILD_MODS_DIR: dir, BUILD_STARTUP_UPDATE: 'false' };
    const build = run(['bun', 'run', 'tools/pack/Build.ts'], env, verbose);

    const expectFailFile = path.join(dir, 'expect-fail.txt');
    if (fs.existsSync(expectFailFile)) {
        const expected = fs
            .readFileSync(expectFailFile, 'utf-8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0);
        if (build.status === 0) {
            console.log(`FAIL ${name}: the build succeeded but expect-fail.txt says it must fail`);
            return false;
        }
        const missing = expected.filter(l => !build.output.includes(l));
        if (missing.length > 0) {
            console.log(`FAIL ${name}: the build failed, but its output lacks:\n  ${missing.join('\n  ')}`);
            return false;
        }
        console.log(`PASS ${name}: the build failed as expected`);
        return true;
    }

    if (build.status !== 0) {
        console.log(`FAIL ${name}: the build failed (exit ${build.status})`);
        return false;
    }

    const check = path.join(dir, 'check.ts');
    if (fs.existsSync(check)) {
        const result = run(['bun', 'run', check], env, true);
        if (result.status !== 0) {
            console.log(`FAIL ${name}: check.ts failed (exit ${result.status})`);
            return false;
        }
    }

    console.log(`PASS ${name}`);
    return true;
}

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const names = args.filter(a => !a.startsWith('--'));

let dirs: string[];
if (args.includes('--all')) {
    dirs = fs
        .readdirSync(FIXTURES, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(FIXTURES, e.name))
        .sort();
} else if (names.length > 0) {
    dirs = names.map(resolveFixture);
} else {
    console.log('Usage: bun run mod:fixture <name|path> [...] | --all [--verbose]');
    console.log(`Fixtures: ${fs.readdirSync(FIXTURES).join(', ')}`);
    process.exit(1);
}

const results = dirs.map(dir => ({ dir, ok: runFixture(dir, verbose) }));

console.log('\n=== summary ===');
for (const { dir, ok } of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${path.basename(dir)}`);
}
console.log('\ndata/pack now holds the last fixture build. Run `bun run build` to build the real mods/ again.');

process.exitCode = results.every(r => r.ok) ? 0 : 1;
