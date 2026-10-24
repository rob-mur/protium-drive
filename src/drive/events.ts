import { DriveEventType, type EventScheduler, type Logger } from '@protontech/drive-sdk';

import type { DriveSdk } from './sdk';
import type { DriveTree } from './tree';

/**
 * Keeps the `DriveTree` cache in line with changes made elsewhere (web app,
 * phone, other clients) by reading Drive events. The SDK's scheduler calls us
 * about every 30 seconds for the own volume; each call reads only the events
 * since the last one, so the server never walks the folder tree to find
 * changes.
 */
export class EventWatcher {
    private scheduler?: EventScheduler;
    private scopeId?: string;
    private lastEventId?: string;
    private stopped = false;
    private readonly abort = new AbortController();

    constructor(
        private readonly sdk: DriveSdk,
        private readonly tree: DriveTree,
        private readonly logger: Logger,
        /** Returns false while Proton calls cannot work (no session), so polls make no request. */
        private readonly canPoll: () => boolean = () => true,
    ) {}

    async start(): Promise<void> {
        const root = await this.tree.root();
        this.scopeId = root.treeEventScopeId;
        this.scheduler = await this.sdk.getEventScheduler((scopeId) => this.poll(scopeId));
        this.scheduler.addScope(this.scopeId);
        this.logger.info(`Watching Drive events for scope ${this.scopeId}`);
    }

    stop(): void {
        this.stopped = true;
        this.abort.abort();
        if (this.scheduler && this.scopeId) {
            this.scheduler.removeScope(this.scopeId);
        }
    }

    /**
     * Reads new events for one scope. Never throws: the SDK scheduler does not
     * handle a rejected callback.
     */
    async poll(scopeId: string): Promise<void> {
        if (this.stopped || scopeId !== this.scopeId) {
            return;
        }
        if (!this.canPoll()) {
            return;
        }
        if (this.tree.backoff.coolingDownSeconds > 0) {
            this.logger.debug('Skipping event poll while rate limited');
            return;
        }
        try {
            for await (const event of this.sdk.iterateEvents(scopeId, this.lastEventId, this.abort.signal)) {
                if (event.type !== DriveEventType.FastForward) {
                    this.logger.debug(`Drive event ${event.type}`);
                }
                if (event.type === DriveEventType.FastForward && this.lastEventId === undefined) {
                    // The first poll starts at the latest event and replays
                    // nothing, so listings loaded before it may miss changes.
                    this.tree.clear();
                } else {
                    this.tree.applyEvent(event);
                }
                // TreeRemove carries the placeholder ID 'none'; never resume from it.
                if (event.eventId && event.eventId !== 'none') {
                    this.lastEventId = event.eventId;
                }
            }
        } catch (error: unknown) {
            if (this.stopped) {
                return;
            }
            this.tree.backoff.note(error);
            this.logger.warn(`Reading Drive events failed: ${String(error)}`);
        }
    }
}
