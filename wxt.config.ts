import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'ChatSync for OpenRouter',
    description: 'Sync your OpenRouter chat history across devices and browsers.',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://openrouter.ai/*',
      'https://api.github.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
