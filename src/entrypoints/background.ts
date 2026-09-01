/**
 * Background (service worker on Chromium, event page on Firefox):
 * sync orchestration, tab bridging, alarms.
 */
import { GithubAdapter } from '@/lib/adapters/github';
import type { SyncAdapter } from '@/lib/adapters/types';
import { WebdavAdapter } from '@/lib/adapters/webdav';
import { CS_VERSION, defaultSettings, type AppSettings, type BgRequest, type BgStatus, type CsRequest, type CsResponse, type SettingsPatch } from '@/lib/messaging';
import { runSync, type LocalSyncState, type SyncDeps } from '@/lib/sync-engine';
import type { SyncReport } from '@/lib/types';
import {
  alarmsClear,
  alarmsGet,
  permissionsContains,
  storageLocalGet,
  storageLocalSet,
  tabsCreate,
  tabsQuery,
  tabsReload,
  tabsRemove,
  tabsSendMessage,
} from '@/lib/webext';

const OPENROUTER_URL = 'https://openrouter.ai/';
const ALARM_NAME = 'chatsync-auto';
const STATE_KEY = 'localSyncState';

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export async function getSettings(): Promise<AppSettings> {
  const stored = await storageLocalGet<{ settings?: Partial<AppSettings> }>('settings');
  const base = defaultSettings();
  if (!stored.settings) return base;
  const s = stored.settings;
  return {
    ...base,
    ...s,
    github: { ...base.github, ...(s.github ?? {}) },
    webdav: { ...base.webdav, ...(s.webdav ?? {}) },
  };
}

async function saveSettingsPatch(patch: SettingsPatch): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = {
    ...current,
    ...patch,
    github: { ...current.github, ...(patch.github ?? {}) },
    webdav: { ...current.webdav, ...(patch.webdav ?? {}) },
  };
  await storageLocalSet({ settings: next });
  await syncAlarm(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* adapter factory                                                     */
/* ------------------------------------------------------------------ */

async function buildAdapter(settings: AppSettings): Promise<SyncAdapter> {
  if (settings.backend === 'github') {
    const { token, repo, branch, root } = settings.github;
    if (!token || !repo) throw new Error('GitHub backend is not configured (token/repo).');
    return new GithubAdapter({ token, repo, branch: branch || undefined, root: root || 'chatsync' });
  }
  if (settings.backend === 'webdav') {
    const { url, username, password } = settings.webdav;
    if (!url || !username) throw new Error('WebDAV backend is not configured (url/username).');
    const origin = new URL(url).origin + '/*';
    const granted = await permissionsContains({ origins: [origin] });
    if (!granted) {
      throw new Error(
        `Missing host permission for ${origin}. Re-save settings to grant it.`,
      );
    }
    return new WebdavAdapter({ url, username, password });
  }
  throw new Error('No sync backend selected. Open settings first.');
}

/* ------------------------------------------------------------------ */
/* openrouter.ai tab bridging                                          */
/* ------------------------------------------------------------------ */

async function findPlaygroundTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await tabsQuery({ url: 'https://openrouter.ai/*' });
  return tabs[0] ?? null;
}

const sendToTab = (tabId: number, msg: CsRequest): Promise<CsResponse> =>
  tabsSendMessage<CsResponse>(tabId, msg);

/** Ping the content script until a CURRENT-version script answers. */
async function waitContentReady(tabId: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await sendToTab(tabId, { type: 'cs:ping' });
      if (res.type === 'pong' && res.v === CS_VERSION) return;
    } catch {
      /* no listener yet */
    }
    if (Date.now() > deadline) throw new Error('openrouter.ai tab did not respond in time.');
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * After an extension reload, content scripts in already-open tabs are
 * orphaned (or stale): reload the tab once if the CURRENT-version script
 * doesn't answer quickly. Also thaws frozen background tabs.
 */
async function ensureResponsiveTab(tabId: number): Promise<void> {
  try {
    const res = await Promise.race([
      sendToTab(tabId, { type: 'cs:ping' }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), 2000)),
    ]);
    if (res.type === 'pong' && res.v === CS_VERSION) return;
  } catch {
    /* fall through to reload */
  }
  await tabsReload(tabId);
  await new Promise((r) => setTimeout(r, 1500));
  await waitContentReady(tabId);
}

interface TabHandle {
  tabId: number;
  created: boolean;
}

async function ensureTab(): Promise<TabHandle> {
  const existing = await findPlaygroundTab();
  if (existing?.id != null) return { tabId: existing.id, created: false };
  const tab = await tabsCreate({ url: OPENROUTER_URL, active: false });
  if (tab.id == null) throw new Error('Failed to open openrouter.ai tab.');
  return { tabId: tab.id, created: true };
}

/* ------------------------------------------------------------------ */
/* sync                                                                */
/* ------------------------------------------------------------------ */

let syncing = false;

async function getLocalSyncState(): Promise<LocalSyncState> {
  const stored = await storageLocalGet<Record<string, LocalSyncState | undefined>>(STATE_KEY);
  return (
    stored[STATE_KEY] ?? {
      lastSeenRoomIds: [],
      localTombstones: [],
    }
  );
}

export async function performSync(): Promise<SyncReport> {
  if (syncing) throw new Error('A sync is already running.');
  syncing = true;
  let handle: TabHandle | null = null;
  try {
    const settings = await getSettings();
    const adapter = await buildAdapter(settings);
    handle = await ensureTab();
    await ensureResponsiveTab(handle.tabId);

    const deps: SyncDeps = {
      adapter,
      stripModelInfo: settings.stripModelInfo,
      readLocal: async () => {
        const res = await sendToTab(handle!.tabId, { type: 'cs:readSnapshot' });
        if (res.type !== 'snapshot') throw new Error('snapshot failed: ' + res.type);
        return { rooms: res.rooms, roomIds: res.roomIds };
      },
      applyRoom: async (roomId, data) => {
        const res = await sendToTab(handle!.tabId, {
          type: 'cs:apply',
          roomId,
          data,
        });
        if (res.type !== 'applied') throw new Error('apply failed for ' + roomId);
      },
      deleteLocalRoom: async (roomId) => {
        const res = await sendToTab(handle!.tabId, {
          type: 'cs:deleteRoom',
          roomId,
        });
        if (res.type !== 'deleted') throw new Error('local delete failed for ' + roomId);
      },
      getLocalState: getLocalSyncState,
      setLocalState: async (state) => {
        await storageLocalSet({ [STATE_KEY]: state });
      },
    };

    const report = await runSync(deps);

    // Pulls wrote into the page's IndexedDB; reload so the React app sees them.
    if (report.pulled.length > 0 || report.deletedRemote.length > 0) {
      try {
        await sendToTab(handle.tabId, { type: 'cs:reload' });
      } catch {
        /* page may already be gone */
      }
    }
    await storageLocalSet({
      lastReport: report,
      lastSyncedAt: report.finishedAt,
    });
    return report;
  } finally {
    if (handle?.created) {
      await tabsRemove(handle.tabId).catch(() => {});
    }
    syncing = false;
  }
}

/* ------------------------------------------------------------------ */
/* alarms                                                              */
/* ------------------------------------------------------------------ */

async function syncAlarm(settings: AppSettings): Promise<void> {
  const minutes = settings.autoSyncMinutes;
  const existing = await alarmsGet(ALARM_NAME);
  if (minutes > 0) {
    if (!existing || existing.periodInMinutes !== minutes) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
    }
  } else if (existing) {
    await alarmsClear(ALARM_NAME);
  }
}

/* ------------------------------------------------------------------ */
/* message router                                                      */
/* ------------------------------------------------------------------ */

async function status(): Promise<BgStatus> {
  const settings = await getSettings();
  const stored = await storageLocalGet<{ lastReport?: SyncReport; lastSyncedAt?: string }>([
    'lastReport',
    'lastSyncedAt',
  ]);
  const configured =
    (settings.backend === 'github' && !!settings.github.token && !!settings.github.repo) ||
    (settings.backend === 'webdav' && !!settings.webdav.url && !!settings.webdav.username);
  return {
    syncing,
    lastReport: stored.lastReport ?? null,
    lastSyncedAt: stored.lastSyncedAt ?? null,
    backend: settings.backend,
    configured,
  };
}

export default defineBackground(async () => {
  console.log('[chatsync] background booted (v' + CS_VERSION + ')');
  chrome.runtime.onMessage.addListener(router);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      void performSync().catch((e) => console.error('[chatsync] auto sync failed:', e));
    }
  });
  // Restore alarm schedule on cold start.
  await syncAlarm(await getSettings());
});

/**
 * IMPORTANT: this must stay a NON-async function that synchronously returns
 * `true`. An async listener returns a Promise, which Firefox treats as the
 * response itself (resolving to `true`) and drops every sendResponse call.
 */
function router(
  msg: BgRequest,
  _sender: unknown,
  sendResponse: (r: unknown) => void,
): boolean {
  void (async () => {
    try {
      switch (msg.type) {
        case 'sync:run': {
          const report = await performSync();
          sendResponse({ ok: true, report });
          break;
        }
        case 'sync:status':
          sendResponse({ ok: true, status: await status() });
          break;
        case 'settings:get':
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case 'settings:set': {
          const next = await saveSettingsPatch(msg.patch);
          sendResponse({ ok: true, settings: next });
          break;
        }
        case 'adapter:test': {
          const settings = await getSettings();
          const adapter = await buildAdapter(settings);
          sendResponse({ ok: true, result: await adapter.test() });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message ' + (msg as { type?: string }).type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true;
}
