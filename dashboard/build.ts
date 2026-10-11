// Builds the dashboard into dist/: the server as one Node file, the browser app as one script.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'public'), { recursive: true });

await build({
  entryPoints: [join(root, 'src/server/main.ts')],
  outfile: join(dist, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some dependencies are CommonJS and call require().
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

await build({
  entryPoints: [join(root, 'src/client/main.tsx')],
  outfile: join(dist, 'public/app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: true,
  logLevel: 'warning',
});

for (const file of ['index.html', 'style.css']) {
  await copyFile(join(root, 'src/client', file), join(dist, 'public', file));
}
process.stdout.write(`Bygget til ${dist}\n`);
