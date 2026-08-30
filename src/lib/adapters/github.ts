/**
 * GitHub repository adapter using the Contents API.
 * Config: token (fine-grained PAT with repo Contents R/W), repo ("owner/name"),
 * and an optional branch (default: repo default branch).
 *
 * One PUT per changed file; each PUT is its own commit.
 */
import type { SyncAdapter } from './types';

export interface GithubConfig {
  token: string;
  repo: string; // "owner/name"
  branch?: string;
  root: string; // directory inside the repo, e.g. "chatsync"
}

interface GhContentsResponse {
  content?: string | null;
  encoding?: string;
  sha?: string;
  message?: string;
}

export class GithubAdapter implements SyncAdapter {
  readonly kind = 'github' as const;
  private readonly cfg: GithubConfig;

  constructor(cfg: GithubConfig) {
    this.cfg = cfg;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  private url(path: string): string {
    const { repo, branch, root } = this.cfg;
    const clean = path.replace(/^\/+/, '');
    const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    return `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(root ? root.replace(/^\/+|\/+$/g, '') + '/' : '')}${clean}${ref}`;
  }

  private async getSha(path: string): Promise<string | undefined> {
    const res = await fetch(this.url(path), { headers: this.headers() });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as GhContentsResponse;
    return json.sha;
  }

  async getManifest(): Promise<string | null> {
    return this.getFile('manifest.json');
  }

  async getFile(path: string): Promise<string | null> {
    const res = await fetch(this.url(path), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
    const json = (await res.json()) as GhContentsResponse;
    if (json.content == null) return null;
    const text =
      json.encoding === 'base64'
        ? atob(json.content.replace(/\n/g, ''))
        : json.content;
    // Contents API returns latin1-decoded bytes; re-encode properly for UTF-8.
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async putFile(path: string, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const sha = await this.getSha(path);
    const body: Record<string, unknown> = {
      message: `chatsync: update ${path}`,
      content: btoa(bin),
    };
    if (sha) body.sha = sha;
    if (this.cfg.branch) body.branch = this.cfg.branch;

    const res = await fetch(this.url(path), {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GitHub PUT ${path}: ${res.status} ${await res.text()}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const sha = await this.getSha(path);
    if (!sha) return;
    const body: Record<string, unknown> = {
      message: `chatsync: delete ${path}`,
      sha,
    };
    if (this.cfg.branch) body.branch = this.cfg.branch;
    const res = await fetch(this.url(path), {
      method: 'DELETE',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`GitHub DELETE ${path}: ${res.status}`);
    }
  }

  async test(): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
    try {
      const res = await fetch(`https://api.github.com/repos/${this.cfg.repo}`, {
        headers: this.headers(),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Token rejected (401/403). Check the PAT scopes.' };
      }
      if (res.status === 404) {
        return { ok: false, error: `Repo "${this.cfg.repo}" not found or no access.` };
      }
      if (!res.ok) return { ok: false, error: `GitHub error ${res.status}` };
      const repo = (await res.json()) as { full_name: string; default_branch: string };
      return {
        ok: true,
        detail: `${repo.full_name} (branch ${this.cfg.branch ?? repo.default_branch})`,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
