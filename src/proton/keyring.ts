/** The system keyring item that holds the key the unlocked-key cache is encrypted with. */
export const KEYRING_ITEM = { service: 'proton-drive-mount', name: 'key-cache' } as const;

/** How long a keyring call may take before pdm treats the keyring as out of reach. */
export const KEYRING_TIMEOUT_MS = 5_000;

/** One keyring item: its value, or `null` when there is none. Each call throws when the keyring cannot be reached. */
export type Keyring = {
    get(): Promise<string | null>;
    set(value: string): Promise<void>;
    delete(): Promise<boolean>;
};

/**
 * The item in the desktop's Secret Service (GNOME Keyring, KWallet, KeePassXC), through Bun's
 * own `Bun.secrets`, which loads libsecret. On a host with no libsecret, or no Secret Service on
 * the session bus, each call throws.
 */
export const systemKeyring: Keyring = {
    get: () => Bun.secrets.get(KEYRING_ITEM),
    set: (value) => Bun.secrets.set({ ...KEYRING_ITEM, value }),
    delete: () => Bun.secrets.delete(KEYRING_ITEM),
};

/** The call's result, or a rejection when it takes longer than `ms`: a keyring that does not answer is out of reach. */
export async function withinTime<T>(call: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the keyring did not answer within ${ms} ms`)), ms);
    });
    try {
        return await Promise.race([call(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
