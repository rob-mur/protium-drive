// The Send arm's systemd half: the socket a `Type=notify` service's manager gives it in
// `NOTIFY_SOCKET`, read as systemd reads it. systemd takes the sender's process id from the
// kernel's credentials on each message, not from the message, and at its default
// `NotifyAccess=main` it ignores a message from any process but the service's main one. This
// socket asks the kernel for the same credentials, so a step can tell which process sent what.
//
// Bun has no unix datagram socket, so this calls libc through bun:ffi. The structures are the
// Linux LP64 ones (x86_64 and aarch64 lay them out alike).
import { dlopen, FFIType, ptr } from "bun:ffi";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AF_UNIX = 1;
const SOCK_DGRAM = 2;
const SOCK_CLOEXEC = 0o2000000;
const SOL_SOCKET = 1;
const SO_PASSCRED = 16;
const SCM_CREDENTIALS = 2;
const MSG_DONTWAIT = 0x40;

const libc = dlopen("libc.so.6", {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  recvmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});

/** One datagram a process sent to the socket. */
export interface Notification {
  /** The sender's process id, as the kernel vouches for it; undefined when it sent no credentials. */
  pid?: number;
  /** The message, such as `READY=1`. */
  text: string;
}

export class NotifySocket {
  private readonly buffer = Buffer.alloc(4096);
  private readonly control = Buffer.alloc(64);
  private readonly iov = Buffer.alloc(16);
  private readonly header = Buffer.alloc(56);
  private closed = false;

  private constructor(
    /** The path a service's `NOTIFY_SOCKET` names. */
    readonly path: string,
    private readonly directory: string,
    private readonly fd: number,
  ) {
    this.iov.writeBigUInt64LE(BigInt(ptr(this.buffer)), 0);
    this.iov.writeBigUInt64LE(BigInt(this.buffer.length), 8);
  }

  /** Binds a fresh socket in a directory of its own. */
  static open(): NotifySocket {
    const directory = mkdtempSync(join(tmpdir(), "pdm-notify-"));
    const path = join(directory, "notify");
    const fd = libc.symbols.socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (fd < 0) throw new Error("socket(AF_UNIX, SOCK_DGRAM) failed");
    const one = Buffer.alloc(4);
    one.writeInt32LE(1, 0);
    const name = Buffer.from(path);
    const address = Buffer.alloc(2 + name.length + 1);
    address.writeUInt16LE(AF_UNIX, 0);
    name.copy(address, 2);
    if (
      libc.symbols.setsockopt(fd, SOL_SOCKET, SO_PASSCRED, ptr(one), 4) !== 0 ||
      libc.symbols.bind(fd, ptr(address), address.length) !== 0
    ) {
      libc.symbols.close(fd);
      throw new Error(`could not bind a notify socket at ${path}`);
    }
    return new NotifySocket(path, directory, fd);
  }

  /** Every message that arrived since the last call, first first. It never waits. */
  take(): Notification[] {
    const taken: Notification[] = [];
    if (this.closed) return taken;
    for (;;) {
      this.header.fill(0);
      this.control.fill(0);
      // struct msghdr: name, namelen, iov, iovlen, control, controllen, flags.
      this.header.writeBigUInt64LE(BigInt(ptr(this.iov)), 16);
      this.header.writeBigUInt64LE(1n, 24);
      this.header.writeBigUInt64LE(BigInt(ptr(this.control)), 32);
      this.header.writeBigUInt64LE(BigInt(this.control.length), 40);
      const size = Number(libc.symbols.recvmsg(this.fd, ptr(this.header), MSG_DONTWAIT));
      if (size < 0) return taken;
      taken.push({ pid: this.senderPid(), text: this.buffer.toString("utf8", 0, size) });
    }
  }

  /** The pid in the message's SCM_CREDENTIALS, from the first control message. */
  private senderPid(): number | undefined {
    const controlLength = Number(this.header.readBigUInt64LE(40));
    // struct cmsghdr: len (8), level (4), type (4), then struct ucred: pid, uid, gid.
    if (controlLength < 28) return undefined;
    if (this.control.readInt32LE(8) !== SOL_SOCKET || this.control.readInt32LE(12) !== SCM_CREDENTIALS) return undefined;
    return this.control.readInt32LE(16);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    libc.symbols.close(this.fd);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
