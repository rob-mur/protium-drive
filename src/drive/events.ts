import { DriveEventType, type DriveEvent } from '@protontech/drive-sdk';

import type { Logger } from '../../vendor/proton-drive-sdk-account';

import { DriveError } from './errors';
import type { DriveSdk } from './sdk';
import type { DriveTree } from './tree';

/** How long the watcher waits before it retries a start that failed. */
export const START_RETRY_MS = 60_000;

export type EventWatcherOptions = {
    /** Why Proton calls cannot work now, or `undefined`; a poll without a session reads no events. */
    authProblem: () => string | undefined;
    /** The timer the retry uses; the fake drive's clock under `--fake-drive`. */
    setTimeout?: (callback: () => unknown, ms: number) => unknown;
    clearTimeout?: (handle: never) => void;
};

/**
 * Keeps the tree's cached listings true by reading Drive events, never by walking the folders.
 *
 * It registers the served volume's event scope with the SDK's event scheduler, which calls back
 * on its own timer. Each call reads only the events since the last one: a node event drops the
 * node's own listing and its parent's; a tree refresh or removal, and the first poll's
 * fast-forward, drop them all. A poll during a rate-limit pause, or without a session, reads
 * nothing. A start that fails (Proton down, no session yet) is retried every 60 s.
 */
export class EventWatcher {
    private lastEventId?: string;
    private stopped = false;
    private retry?: unknown;
    private scheduler?: { removeScope(scopeId: string): void };
    private scopeId?: string;

    constructor(
        private readonly sdk: DriveSdk,
        private readonly tree: DriveTree,
        private readonly logger: Logger,
        private readonly options: EventWatcherOptions,
    ) {}

    /** Registers the scope with the scheduler; on failure, schedules its own retry instead of throwing. */
    async start(): Promise<void> {
        if (this.stopped) {
            return;
        }
        try {
            const root = await this.tree.root();
            const scheduler = await this.sdk.getEventScheduler((scopeId) => this.poll(scopeId));
            scheduler.addScope(root.treeEventScopeId);
            this.scheduler = scheduler;
            this.scopeId = root.treeEventScopeId;
        } catch (error: unknown) {
            this.logger.warn(`Cannot watch Drive events, retrying in ${START_RETRY_MS / 1000}s: ${describe(error)}`);
            const setTimer = this.options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
            this.retry = setTimer(() => this.start(), START_RETRY_MS);
        }
    }

    stop(): void {
        this.stopped = true;
        if (this.retry !== undefined) {
            (this.options.clearTimeout ?? clearTimeout)(this.retry as never);
        }
        if (this.scopeId !== undefined) {
            this.scheduler?.removeScope(this.scopeId);
        }
    }

    private async poll(_scopeId: string): Promise<void> {
        if (this.options.authProblem() !== undefined) {
            return;
        }
        try {
            this.tree.backoff.check();
        } catch (error: unknown) {
            if (error instanceof DriveError) {
                return;
            }
            throw error;
        }
        try {
            await this.tree.backoff.run(async () => {
                for await (const event of this.sdk.iterateEvents(_scopeId, this.lastEventId)) {
                    this.apply(event);
                    this.lastEventId = event.eventId;
                }
            });
        } catch (error: unknown) {
            this.logger.warn(`Cannot read Drive events: ${describe(error)}`);
        }
    }

    private apply(event: DriveEvent): void {
        switch (event.type) {
            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated:
            case DriveEventType.NodeDeleted:
                this.tree.dropListings([event.nodeUid, event.parentNodeUid]);
                return;
            case DriveEventType.TreeRefresh:
            case DriveEventType.TreeRemove:
            case DriveEventType.FastForward:
                this.tree.clear();
                return;
            default:
                return;
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
