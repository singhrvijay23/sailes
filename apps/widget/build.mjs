import * as esbuild from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const options = {
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  outfile: 'dist/sailes.js',
  legalComments: 'none',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
  const size = gzipSync(readFileSync('dist/sailes.js')).length;
  console.log(`sailes.js gzipped: ${(size / 1024).toFixed(1)} KB (budget 60 KB)`);
  if (size > 60 * 1024) process.exit(1);
}
