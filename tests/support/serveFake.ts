/**
 * Serves the fake SDK over WebDAV, for trying rclone (or `rclone mount`)
 * without a Proton account. Nothing is sent to Proton; data lives in memory.
 *
 *   bun tests/support/serveFake.ts [--port 7395]
 */
import { parseArgs } from 'node:util';

import { startApp } from '../../src/app';
import { createLogger } from '../../src/logger';
import { FakeDriveSdk } from './fakeSdk';

const { values } = parseArgs({ options: { port: { type: 'string', default: '7395' } } });
const fake = new FakeDriveSdk();
fake.remoteWrite('Welcome/readme.txt', 'This folder lives in memory. Nothing here reaches Proton.\n');
const app = startApp({ sdk: fake, logger: createLogger(), host: '127.0.0.1', port: Number(values.port), watchEvents: false });
console.error(`Fake Drive served at ${app.server.url.href} (Ctrl-C to stop)`);
