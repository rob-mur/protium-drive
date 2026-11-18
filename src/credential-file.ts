import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

/**
 * Reads the credential a standalone serve demands (`serve --credential-file PATH`): the whole
 * file with the whitespace around it trimmed. It throws, with a message for the user, when the
 * file cannot be read, is not a file, is empty, or lets group or other use it (any bit of
 * 0o077), as ssh refuses a private key. A symlink is judged by the file it points to.
 *
 * It checks the mode of the file it opened and reads that same file, so the file cannot change
 * between the check and the read.
 */
export function readCredentialFile(path: string): string {
    let fd: number;
    try {
        // Non-blocking, so a FIFO at the path cannot hang the serve; isFile then refuses it.
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error: unknown) {
        throw new Error(`The credential file ${path} cannot be read: ${reason(error)}`);
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
            throw new Error(`The credential file ${path} is not a file.`);
        }
        const mode = stat.mode & 0o7777;
        if (mode & 0o077) {
            const octal = mode.toString(8).padStart(4, '0');
            throw new Error(`The credential file ${path} has mode ${octal}: group or other can use it. Run "chmod 600 ${path}".`);
        }
        const credential = readFileSync(fd, 'utf8').trim();
        if (credential === '') {
            throw new Error(`The credential file ${path} is empty.`);
        }
        return credential;
    } finally {
        closeSync(fd);
    }
}

function reason(error: unknown): string {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'it does not exist.';
    if (code === 'EACCES') return 'permission denied.';
    return error instanceof Error ? error.message : String(error);
}
