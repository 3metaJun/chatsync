import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  // MV3 for every browser: Firefox 128+ fully supports it (event-page
  // background + optional host permissions), and the WebDAV dynamic-origin
  // flow needs optional_host_permissions.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'ChatSync for OpenRouter',
    description: 'Sync your OpenRouter chat history across devices and browsers.',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://openrouter.ai/*',
      'https://api.github.com/*',
      // localhost entry covers self-hosted/loopback WebDAV. Firefox treats
      // match-pattern hosts as port-agnostic, same as Chrome.
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'chatsync@3metajun.dev',
              strict_min_version: '128.0',
            },
          },
        }
      : {}),
  }),
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
