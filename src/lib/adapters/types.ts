/**
 * Remote sync backend contract. Implementations store:
 *   <root>/manifest.json          — SyncManifest
 *   <root>/rooms/<roomId>.json    — OrpgExport (single room, official format)
 */

export interface SyncAdapter {
  readonly kind: 'github' | 'webdav';

  /** Fetch the remote manifest, or null when never initialized. */
  getManifest(): Promise<string | null>;

  /** Put a file (UTF-8 JSON text) at a path relative to the sync root. */
  putFile(path: string, text: string): Promise<void>;

  /** Fetch a file relative to the sync root, or null when missing. */
  getFile(path: string): Promise<string | null>;

  /** Delete a file relative to the sync root. Missing is not an error. */
  deleteFile(path: string): Promise<void>;

  /** Cheap authenticated ping used by the options page "Test connection". */
  test(): Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
}
