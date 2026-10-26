/**
 * The Receive arm's entry point: the test-only stand-in for Proton Drive that the binary uses
 * when it starts with `--fake-drive DIR`. Nothing here reaches Proton.
 *
 * Contract, for the product's `--fake-drive` switch:
 * - `startReceiveArm(DIR)` opens the Drive kept in `DIR` (it creates `DIR` and an empty Drive if
 *   there is none), so a restart, or `auth login` then `serve`, on one `DIR` sees one Drive.
 * - `client` is the SDK surface to use in place of `ProtonDriveClient`. Each call checks the
 *   account's access token first, and meets the faults the control channel sets (faults.ts).
 * - `account` stands in for the vendored account module: the product calls
 *   `account.initAccount({ authClientId, credentials })` in place of the module's `initAccount`,
 *   with its own `SessionCredentials`, and uses the `auth` and `apiClient` it returns (account.ts).
 * - `clock` is the `now()` and the timers to use in place of the real ones (clock.ts). The Drive's
 *   event scheduler runs on it too.
 * - `controlUrl` is the control channel (see control.ts), on 127.0.0.1 at a port the system
 *   allocates. The Receive arm prints it as one line that matches `CONTROL_LINE`, on stderr
 *   unless `print` says otherwise.
 * - `stop()` closes the control channel. The Drive's state is already in `DIR`.
 *
 * On its own, for a look from the outside: `bun fake-drive/receive-arm.ts DIR` runs the control
 * channel until SIGINT or SIGTERM.
 */
import { FakeAccount } from './account.ts';
import { type Clock, FakeClock } from './clock.ts';
import { type ControlChannel, startControlChannel } from './control.ts';
import { FakeDrive, FakeDriveClient, type SdkSurface } from './drive.ts';
import { Faults } from './faults.ts';

/** The line the Receive arm prints; group 1 is the control channel's URL. */
export const CONTROL_LINE = /^fake-drive: control channel at (http:\/\/127\.0\.0\.1:\d+\/)$/m;

export type ReceiveArm = {
    client: SdkSurface;
    account: Pick<FakeAccount, 'initAccount'>;
    clock: Clock;
    controlUrl: URL;
    stop(): Promise<void>;
};

export type ReceiveArmOptions = {
    /** Where the control channel's URL line goes. Default: stderr. */
    print?: (line: string) => void;
};

export async function startReceiveArm(dir: string, options: ReceiveArmOptions = {}): Promise<ReceiveArm> {
    const print = options.print ?? ((line: string) => process.stderr.write(`${line}\n`));
    const drive = FakeDrive.open(dir);
    const account = FakeAccount.open(dir);
    const clock = new FakeClock();
    const faults = new Faults();
    const client = new FakeDriveClient(drive, { account, clock, faults });
    const control: ControlChannel = startControlChannel(drive, client, { account, clock, faults });
    print(`fake-drive: control channel at ${control.url.href}`);
    return { client, account, clock, controlUrl: control.url, stop: control.stop };
}

if (import.meta.main) {
    const dir = process.argv[2];
    if (!dir) {
        process.stderr.write('usage: bun fake-drive/receive-arm.ts DIR\n');
        process.exit(2);
    }
    const arm = await startReceiveArm(dir);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => void arm.stop().then(() => process.exit(0)));
    }
}
