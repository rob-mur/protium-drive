import { describe, expect, test } from 'bun:test';

import { RequirementError, Requirements } from './requirements.ts';

describe('the requirements', () => {
    test('send no headers while none is set', () => {
        expect(new Requirements().headers()).toBeUndefined();
    });

    test('send the feature masks and the versions in the format of Proton’s headers', () => {
        const requirements = new Requirements();
        requirements.set({ photos: 1, drive: 2, suggested: '99.1.0', required: '99.0.0' });
        const headers = requirements.headers();
        expect(headers?.get('x-pm-drive-requirements')).toBe('drive=2 photos=1');
        expect(headers?.get('x-pm-drive-platform-requirements')).toBe('required=99.0.0 suggested=99.1.0');
    });

    test('send only the header that something set', () => {
        const requirements = new Requirements();
        requirements.set({ suggested: '99.0.0' });
        expect(requirements.headers()?.get('x-pm-drive-requirements')).toBeNull();
        expect(requirements.headers()?.get('x-pm-drive-platform-requirements')).toBe('suggested=99.0.0');
    });

    test('replace what was set, and an empty set clears it', () => {
        const requirements = new Requirements();
        requirements.set({ drive: 2 });
        expect(requirements.set({ required: '99.0.0' })).toEqual({ required: '99.0.0' });
        expect(requirements.set({})).toEqual({});
        expect(requirements.headers()).toBeUndefined();
    });

    test('refuse a mask, a version or a name that is not a requirement, and keep what was set', () => {
        const requirements = new Requirements();
        requirements.set({ drive: 2 });
        for (const bad of [{ drive: 0 }, { photos: 1.5 }, { docs: '2' }, { required: 'new' }, { suggested: 99 }, { mail: 1 }]) {
            expect(() => requirements.set(bad)).toThrow(RequirementError);
        }
        expect(requirements.current()).toEqual({ drive: 2 });
    });
});
