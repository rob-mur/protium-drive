import { describe, expect, test } from 'bun:test';

import { APP_DIR_NAME, resolveStateDir } from './paths.ts';
import { KEYRING_ITEM } from './proton/keyring.ts';

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

describe('names that outlive the rename to protium-drive (#143)', () => {
    test('the state dir and the keyring item keep the old name, so an install keeps its login and key cache', () => {
        expect(APP_DIR_NAME).toBe('proton-drive-mount');
        expect(KEYRING_ITEM).toEqual({ service: 'proton-drive-mount', name: 'key-cache' });
    });
});
