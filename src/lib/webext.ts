/**
 * Promise helpers over WebExtension APIs, implemented with CALLBACK-style
 * invocations only. Chrome supports both styles; Firefox's `chrome.*`
 * namespace is callback-first, so going through callbacks behaves
 * identically on every browser.
 */

export function storageLocalGet<T = Record<string, unknown>>(
  keys?: string | string[] | Record<string, unknown> | null,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys ?? null, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res as T);
    });
  });
}

export function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export function tabsQuery(info: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(info, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(tabs);
    });
  });
}

export function tabsCreate(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(tab!);
    });
  });
}

export function tabsReload(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.tabs.reload(tabId, {}, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export function tabsRemove(tabIds: number | number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    chrome.tabs.remove(ids[0], () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

/** Send a message to the extension's own background; callback style works everywhere. */
export function sendMessage<T>(msg: object, timeoutMs = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('background did not respond (timeout)')),
      timeoutMs,
    );
    try {
      chrome.runtime.sendMessage(msg, (res: unknown) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res as T);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Send a message to a tab's content script; callback style works everywhere. */
export function tabsSendMessage<T>(tabId: number, msg: object, timeoutMs = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('content script did not respond (timeout)')),
      timeoutMs,
    );
    try {
      chrome.tabs.sendMessage(tabId, msg, (res: unknown) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res as T);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export function alarmsGet(name: string): Promise<chrome.alarms.Alarm | undefined> {
  return new Promise((resolve) => {
    chrome.alarms.get(name, (alarm) => resolve(alarm ?? undefined));
  });
}

export function alarmsClear(name: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.alarms.clear(name, () => resolve());
  });
}

export function permissionsContains(permissions: chrome.permissions.Permissions): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.permissions.contains(permissions, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

export function permissionsRequest(permissions: chrome.permissions.Permissions): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.permissions.request(permissions, (granted) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(granted);
    });
  });
}
