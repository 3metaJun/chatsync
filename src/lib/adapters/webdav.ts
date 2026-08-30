/**
 * WebDAV adapter (basic-auth, plain fetch). Works with Nextcloud, nut store
 * (坚果云), Synology, rclone serve webdav, etc.
 *
 * The origin is not pre-declared in host_permissions; the background asks
 * for optional per-origin permission before the first request.
 */
import type { SyncAdapter } from './types';

export interface WebdavConfig {
  url: string; // full base URL of the sync directory
  username: string;
  password: string;
}

export class WebdavAdapter implements SyncAdapter {
  readonly kind = 'webdav' as const;
  private readonly cfg: WebdavConfig;

  constructor(cfg: WebdavConfig) {
    this.cfg = cfg;
  }

  private url(path: string): string {
    const base = this.cfg.url.replace(/\/+$/, '');
    const clean = path.replace(/^\/+/, '');
    return `${base}/${clean}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const auth = btoa(`${this.cfg.username}:${this.cfg.password}`);
    return { Authorization: `Basic ${auth}`, ...extra };
  }

  /** Ensure parent collections exist (MKCOL is idempotent-ish; 405 = exists). */
  private async mkdirs(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    // path starts with the room file; drop the file itself
    parts.pop();
    const { origin } = new URL(this.cfg.url);
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      const u = `${origin}${acc}`;
      try {
        const res = await fetch(u, { method: 'MKCOL', headers: this.headers() });
        // 201 created, 405 already exists, 301 weird but tolerable
        if (!res.ok && res.status !== 405) {
          throw new Error(`MKCOL ${acc}: ${res.status}`);
        }
      } catch {
        // some servers reject MKCOL on existing collections — treat as ok
      }
    }
  }

  async getManifest(): Promise<string | null> {
    return this.getFile('manifest.json');
  }

  async getFile(path: string): Promise<string | null> {
    const res = await fetch(this.url(path), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WebDAV GET ${path}: ${res.status}`);
    return res.text();
  }

  async putFile(path: string, text: string): Promise<void> {
    await this.mkdirs(path);
    const res = await fetch(this.url(path), {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: text,
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`WebDAV PUT ${path}: ${res.status}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const res = await fetch(this.url(path), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404 && res.status !== 204) {
      throw new Error(`WebDAV DELETE ${path}: ${res.status}`);
    }
  }

  async test(): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
    try {
      const res = await fetch(this.url('manifest.json'), {
        method: 'PROPFIND',
        headers: this.headers({ Depth: '0' }),
      });
      if (res.status === 401) return { ok: false, error: 'Unauthorized (401). Check credentials.' };
      if (res.status === 404) {
        // directory itself missing — try a PUT probe on the base URL
        const probe = await fetch(this.cfg.url, {
          method: 'OPTIONS',
          headers: this.headers(),
        });
        if (!probe.ok) {
          return { ok: false, error: `Path not found and server answered ${probe.status}.` };
        }
      }
      return { ok: true, detail: new URL(this.cfg.url).host };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
