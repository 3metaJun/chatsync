/**
 * Message contracts between popup/options UI, background, and the
 * openrouter.ai content script.
 */
import type { LocalRoomSnapshot, OrpgExport, SyncReport } from './types';

/* ---- background -> content script ---- */
/** Bump when content-script behavior changes; stale scripts get reloaded. */
export const CS_VERSION = 2;

export type CsRequest =
  | { type: 'cs:ping' }
  | { type: 'cs:readSnapshot' }
  | { type: 'cs:apply'; roomId: string; data: OrpgExport }
  | { type: 'cs:deleteRoom'; roomId: string }
  | { type: 'cs:reload' };

export type CsResponse =
  | { type: 'pong'; v: number }
  | { type: 'snapshot'; rooms: LocalRoomSnapshot[]; roomIds: string[] }
  | { type: 'applied' }
  | { type: 'deleted' }
  | { type: 'reloading' }
  | { type: 'error'; message: string };

/* ---- UI -> background ---- */
export type BgRequest =
  | { type: 'sync:run' }
  | { type: 'sync:status' }
  | { type: 'settings:get' }
  | { type: 'settings:set'; patch: SettingsPatch }
  | { type: 'adapter:test' };

export interface BgStatus {
  syncing: boolean;
  lastReport: SyncReport | null;
  lastSyncedAt: string | null;
  backend: AppSettings['backend'];
  configured: boolean;
}

/* ---- settings ---- */
export interface GithubSettings {
  token: string;
  repo: string;
  branch: string;
  root: string;
}

export interface WebdavSettings {
  url: string;
  username: string;
  password: string;
}

export interface AppSettings {
  backend: 'github' | 'webdav' | null;
  github: GithubSettings;
  webdav: WebdavSettings;
  stripModelInfo: boolean;
  autoSyncMinutes: number; // 0 = manual only
  deviceId: string;
}

export type SettingsPatch = Partial<
  Omit<AppSettings, 'github' | 'webdav'> & {
    github: Partial<GithubSettings>;
    webdav: Partial<WebdavSettings>;
  }
>;

export const defaultSettings = (): AppSettings => ({
  backend: null,
  github: { token: '', repo: '', branch: '', root: 'chatsync' },
  webdav: { url: '', username: '', password: '' },
  stripModelInfo: false,
  autoSyncMinutes: 0,
  deviceId: crypto.randomUUID(),
});
