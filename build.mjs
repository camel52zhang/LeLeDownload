import { build } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

build({
  root: __dirname,
  logLevel: 'info',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
}).catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});