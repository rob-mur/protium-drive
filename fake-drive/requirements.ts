/**
 * The Receive arm's Drive requirements: what Proton's `x-pm-drive-requirements` and
 * `x-pm-drive-platform-requirements` response headers would say. The control channel sets them
 * (`POST /requirements`). They live in memory, in the process whose control channel set them.
 *
 * - `drive`, `photos`, `docs`: the feature mask Proton requires for that scope, a whole number of
 *   1 or more. Sent as `x-pm-drive-requirements: drive=2 photos=1`.
 * - `required`, `suggested`: the SDK version Proton requires or suggests, for example `99.0.0`.
 *   Sent as `x-pm-drive-platform-requirements: required=99.0.0 suggested=99.1.0`.
 *
 * The format is the one the vendored parser reads (vendor/proton-drive-cli/apiRequirements.ts).
 * The fake drive has no HTTP layer for the product's calls, so it gives the headers to the
 * product's response hooks itself: after each SDK-surface call it passes each hook a response
 * that carries them (drive.ts, `FakeDriveClient.onResponse`). With nothing set, it passes none.
 */

export const REQUIREMENT_SCOPES = ['drive', 'photos', 'docs'] as const;
export type RequirementScope = (typeof REQUIREMENT_SCOPES)[number];

export type RequirementSpec = Partial<Record<RequirementScope, number>> & { required?: string; suggested?: string };

/** A requirement the Receive arm cannot set. */
export class RequirementError extends Error {
    override name = 'RequirementError';
}

/** A hook as ky runs it after a response, and as the product's requirement hook takes it. */
export type ResponseHook = (request: Request, options: unknown, response: Response) => unknown;

const VERSION = /^\d+\.\d+\.\d+$/;

export class Requirements {
    private spec: RequirementSpec = {};

    /** Replaces what was set. An empty spec sets nothing, so the calls pass no response again. */
    set(spec: Record<string, unknown>): RequirementSpec {
        const next: RequirementSpec = {};
        for (const [name, value] of Object.entries(spec)) {
            if ((REQUIREMENT_SCOPES as readonly string[]).includes(name)) {
                if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
                    throw new RequirementError(`${name} is not a feature mask of 1 or more`);
                }
                next[name as RequirementScope] = value;
            } else if (name === 'required' || name === 'suggested') {
                if (typeof value !== 'string' || !VERSION.test(value)) throw new RequirementError(`${name} is not a version such as 1.2.3`);
                next[name] = value;
            } else {
                throw new RequirementError(`${name} is not a requirement: give ${[...REQUIREMENT_SCOPES, 'required', 'suggested'].join(', ')}`);
            }
        }
        this.spec = next;
        return this.current();
    }

    current(): RequirementSpec {
        return { ...this.spec };
    }

    /** The response headers that carry what is set; none when nothing is. */
    headers(): Headers | undefined {
        const headers = new Headers();
        const features = REQUIREMENT_SCOPES.flatMap((scope) => (this.spec[scope] === undefined ? [] : [`${scope}=${this.spec[scope]}`]));
        if (features.length) headers.set('x-pm-drive-requirements', features.join(' '));
        const platform = (['required', 'suggested'] as const).flatMap((name) => (this.spec[name] === undefined ? [] : [`${name}=${this.spec[name]}`]));
        if (platform.length) headers.set('x-pm-drive-platform-requirements', platform.join(' '));
        return features.length || platform.length ? headers : undefined;
    }
}
