// Varianta online: aceeasi pagina ca src/local/public/index.html, cu web/main.js in loc de app.js.
import fs from 'node:fs';
import { defineConfig } from 'vite';

const page = () => fs.readFileSync('src/local/public/index.html', 'utf8')
  .replace(/<link rel="stylesheet" href="\/style.css">\s*/, '')
  .replace('<script type="module" src="/app.js"></script>', '<script type="module" src="/main.js"></script>');

export default defineConfig({
  root: 'web',
  envDir: '..',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { fs: { allow: ['..'] } },
  plugins: [{ name: 'shared-page', transformIndexHtml: { order: 'pre', handler: page } }],
});
