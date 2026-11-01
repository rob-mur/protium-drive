import { describe, expect, test } from 'bun:test';

import { resolveStateDir } from './paths.ts';

describe('resolveStateDir', () => {
    test('--state-dir wins, resolved', () => {
        expect(resolveStateDir('/tmp/pdm-state', {})).toBe('/tmp/pdm-state');
        expect(resolveStateDir('relative/dir', { HOME: '/home/u' })).toMatch(/relative\/dir$/);
    });

    test('without the flag it is $XDG_STATE_HOME/proton-drive-mount', () => {
        expect(resolveStateDir(undefined, { XDG_STATE_HOME: '/xdg/state' })).toBe('/xdg/state/proton-drive-mount');
    });

    test('without XDG_STATE_HOME it falls back to ~/.local/state', () => {
        expect(resolveStateDir(undefined, { HOME: '/home/u' })).toBe('/home/u/.local/state/proton-drive-mount');
    });
});
