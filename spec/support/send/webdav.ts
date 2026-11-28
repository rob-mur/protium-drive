// The one WebDAV request no stock client sends on its own: a PROPFIND for a whole tree at once
// (`Depth: infinity`), which a hostile or careless client could use to make the serve walk the
// Drive. Every other request goes through rclone (rclone.ts).

export interface RawAnswer {
  /** Undefined when the serve did not answer. */
  status?: number;
  body: string;
  /** Why no answer came, when none came. */
  error?: string;
}

/** `PROPFIND` with `Depth: infinity` on the folder `path` of the serve at `url`, with the serve's `credential` when it has one. */
export async function propfindWholeTree(url: string, path: string, credential?: string): Promise<RawAnswer> {
  const target = new URL(`${path.split("/").map(encodeURIComponent).join("/")}/`, url);
  try {
    const response = await fetch(target, {
      method: "PROPFIND",
      headers: { Depth: "infinity", "Content-Type": "application/xml", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, body: await response.text() };
  } catch (error: unknown) {
    return { body: "", error: String(error) };
  }
}
