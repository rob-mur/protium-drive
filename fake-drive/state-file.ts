import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

/**
 * One JSON file of Receive arm state in `DIR`, shared by every process on that `DIR`. Each change
 * rewrites it atomically, and each read reloads it when another process changed it.
 */
export class StateFile<T extends { format: number }> {
    private state!: T;
    private seen?: string;

    /** Opens `path`, and writes `initial()` there if it holds nothing. */
    constructor(
        private readonly path: string,
        initial: () => T,
    ) {
        if (existsSync(path)) {
            this.reload();
        } else {
            this.state = initial();
            this.save();
        }
    }

    /** The latest state. Change it only through `change`. */
    read(): Readonly<T> {
        if (this.stamp() !== this.seen) this.reload();
        return this.state;
    }

    /** Runs `fn` on the latest state and saves what it changed. When `fn` throws, nothing changes. */
    change<R>(fn: (state: T) => R): R {
        this.read();
        try {
            const result = fn(this.state);
            this.save();
            return result;
        } catch (error: unknown) {
            this.reload();
            throw error;
        }
    }

    private reload(): void {
        const state = JSON.parse(readFileSync(this.path, 'utf8')) as T;
        if (state.format !== 1) throw new Error(`fake-drive: ${this.path} has format ${String(state.format)}, not 1`);
        this.state = state;
        this.seen = this.stamp();
    }

    private save(): void {
        const temporary = `${this.path}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
        renameSync(temporary, this.path);
        this.seen = this.stamp();
    }

    private stamp(): string | undefined {
        const stat = statSync(this.path, { throwIfNoEntry: false });
        return stat && `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    }
}
