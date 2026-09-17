import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);
const agentDir = path.join(root, 'agent');
const require = createRequire(path.join(agentDir, 'package.json'));
const { build } = require('esbuild');
const outDir = path.join(root, 'dist');

fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(agentDir, 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'cjs',
  outfile: path.join(outDir, 'agent.bundle.cjs'),
  sourcemap: false,
  minify: false,
  packages: 'bundle',
});

fs.writeFileSync(
  path.join(root, 'sea-config.json'),
  JSON.stringify(
    {
      main: path.join(outDir, 'agent.bundle.cjs'),
      mainFormat: 'commonjs',
      output: path.join(outDir, 'MoonWolf-Agent.exe'),
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useVfs: false,
    },
    null,
    2,
  ),
);

console.log('Bundle creado:', path.join(outDir, 'agent.bundle.cjs'));
console.log('SEA config creado:', path.join(root, 'sea-config.json'));
