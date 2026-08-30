import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, BgRequest, SettingsPatch } from '@/lib/messaging';

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; detail: string }
  | { phase: 'fail'; error: string };

type SaveState = { phase: 'idle' } | { phase: 'saving' } | { phase: 'saved' };

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-neutral-400">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-white outline-none focus:border-neutral-500"
      />
      {hint && <span className="mt-1 block text-xs text-neutral-600">{hint}</span>}
    </label>
  );
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const [save, setSave] = useState<SaveState>({ phase: 'idle' });

  useEffect(() => {
    void chrome.runtime
      .sendMessage({ type: 'settings:get' } satisfies BgRequest)
      .then((r: { ok: boolean; settings: AppSettings }) =>
        setSettings(r.settings),
      );
  }, []);

  const patch = useCallback((p: SettingsPatch) => {
    setSettings((s) =>
      s
        ? {
            ...s,
            ...p,
            github: { ...s.github, ...(p.github ?? {}) },
            webdav: { ...s.webdav, ...(p.webdav ?? {}) },
          }
        : s,
    );
    setSave({ phase: 'idle' });
    setTest({ phase: 'idle' });
  }, []);

  const persist = useCallback(async () => {
    if (!settings) return;
    setSave({ phase: 'saving' });
    // WebDAV origin permission needs a user gesture: request it here.
    if (settings.backend === 'webdav' && settings.webdav.url) {
      try {
        const origin = new URL(settings.webdav.url).origin + '/*';
        const has = await chrome.permissions.contains({ origins: [origin] });
        if (!has) await chrome.permissions.request({ origins: [origin] });
      } catch {
        /* user may decline; backend will surface the error on sync */
      }
    }
    await chrome.runtime.sendMessage({
      type: 'settings:set',
      patch: settings,
    } satisfies BgRequest);
    setSave({ phase: 'saved' });
  }, [settings]);

  const runTest = useCallback(async () => {
    if (!settings) return;
    await persist();
    setTest({ phase: 'testing' });
    const res = (await chrome.runtime.sendMessage({
      type: 'adapter:test',
    } satisfies BgRequest)) as {
      ok: boolean;
      result?: { ok: boolean; detail?: string; error?: string };
      error?: string;
    };
    if (res.ok && res.result?.ok) {
      setTest({ phase: 'ok', detail: res.result.detail ?? '' });
    } else {
      setTest({
        phase: 'fail',
        error: res.result?.error ?? res.error ?? 'test failed',
      });
    }
  }, [settings, persist]);

  if (!settings) {
    return <div className="p-6 text-sm text-neutral-500">loading…</div>;
  }

  return (
    <div className="mx-auto max-w-xl p-6 text-sm">
      <h1 className="text-base font-semibold tracking-wide">CHATSYNC SETTINGS</h1>

      <section className="mt-6">
        <h2 className="text-xs font-medium text-neutral-400">BACKEND</h2>
        <div className="mt-2 flex gap-4">
          {(['github', 'webdav'] as const).map((b) => (
            <label key={b} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="backend"
                checked={settings.backend === b}
                onChange={() => patch({ backend: b })}
              />
              {b === 'github' ? 'GitHub repo' : 'WebDAV'}
            </label>
          ))}
        </div>
      </section>

      {settings.backend === 'github' && (
        <section className="mt-6 space-y-3">
          <h2 className="text-xs font-medium text-neutral-400">GITHUB</h2>
          <Field
            label="Personal access token"
            type="password"
            value={settings.github.token}
            onChange={(v) => patch({ github: { ...settings.github, token: v } })}
            hint="Fine-grained PAT with Contents read/write on one private repo."
          />
          <Field
            label="Repository (owner/name)"
            value={settings.github.repo}
            onChange={(v) => patch({ github: { ...settings.github, repo: v } })}
            placeholder="alice/openrouter-chat-sync"
          />
          <Field
            label="Branch (optional)"
            value={settings.github.branch}
            onChange={(v) => patch({ github: { ...settings.github, branch: v } })}
            placeholder="default branch"
          />
          <Field
            label="Directory in repo"
            value={settings.github.root}
            onChange={(v) => patch({ github: { ...settings.github, root: v } })}
            placeholder="chatsync"
          />
        </section>
      )}

      {settings.backend === 'webdav' && (
        <section className="mt-6 space-y-3">
          <h2 className="text-xs font-medium text-neutral-400">WEBDAV</h2>
          <Field
            label="Base URL"
            value={settings.webdav.url}
            onChange={(v) => patch({ webdav: { ...settings.webdav, url: v } })}
            placeholder="https://dav.example.com/chatsync"
          />
          <Field
            label="Username"
            value={settings.webdav.username}
            onChange={(v) => patch({ webdav: { ...settings.webdav, username: v } })}
          />
          <Field
            label="Password / app password"
            type="password"
            value={settings.webdav.password}
            onChange={(v) => patch({ webdav: { ...settings.webdav, password: v } })}
          />
        </section>
      )}

      <section className="mt-6 space-y-3">
        <h2 className="text-xs font-medium text-neutral-400">SYNC</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.stripModelInfo}
            onChange={(e) => patch({ stripModelInfo: e.target.checked })}
          />
          Strip model catalog snapshots (smaller payloads)
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-neutral-400">
            Auto sync interval (minutes, 0 = manual)
          </span>
          <input
            type="number"
            min={0}
            max={720}
            value={settings.autoSyncMinutes}
            onChange={(e) =>
              patch({ autoSyncMinutes: Math.max(0, Number(e.target.value) || 0) })
            }
            className="mt-1 w-24 border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-white outline-none focus:border-neutral-500"
          />
        </label>
      </section>

      <div className="mt-8 flex items-center gap-3">
        <button
          onClick={persist}
          className="border border-neutral-700 px-4 py-1.5 text-sm font-medium hover:bg-neutral-900"
        >
          save
        </button>
        <button
          onClick={runTest}
          className="border border-neutral-700 px-4 py-1.5 text-sm font-medium hover:bg-neutral-900"
        >
          save & test connection
        </button>
        {save.phase === 'saved' && (
          <span className="text-xs text-neutral-500">saved</span>
        )}
      </div>

      {test.phase === 'testing' && (
        <p className="mt-3 font-mono text-xs text-neutral-400">testing…</p>
      )}
      {test.phase === 'ok' && (
        <p className="mt-3 font-mono text-xs text-green-400">connected · {test.detail}</p>
      )}
      {test.phase === 'fail' && (
        <p className="mt-3 font-mono text-xs text-red-400">{test.error}</p>
      )}

      <p className="mt-10 text-xs leading-relaxed text-neutral-600">
        Chats are stored as orpg.3.0 JSON files (one per room) plus a
        manifest.json. Any device pointing at the same backend merges by room
        id with newest-wins conflict resolution. Deletions propagate via
        tombstones.
      </p>
    </div>
  );
}
