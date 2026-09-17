import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['agent/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/agent.cjs',
  logLevel: 'info',
});

console.log('✅ Build completado → dist/agent.cjs');

import fs from 'node:fs/promises';
import path from 'node:path';

const LEGACY_BASE_DIR_PATTERNS = [
  /const\s+BASE_DIR\s*=\s*['"]C:\\Users\\HP\\Desktop\\Proyectos\\Minecraft Servers\\MoonWolf['"]\s*;?/,
  /let\s+BASE_DIR\s*=\s*['"]C:\\Users\\HP\\Desktop\\Proyectos\\Minecraft Servers\\MoonWolf['"]\s*;?/,
  /var\s+BASE_DIR\s*=\s*['"]C:\\Users\\HP\\Desktop\\Proyectos\\Minecraft Servers\\MoonWolf['"]\s*;?/,
];

const PORTABLE_BASE_DIR ="const BASE_DIR = process.env.MOONWOLF_BASE_DIR || path.join(process.cwd());";

const portableServerPlugin = {
  name: 'moonwolf-portable-server',
  setup(build) {
    build.onLoad({ filter: /server\.js$/ }, async (args) => {
      let source = await fs.readFile(args.path, 'utf8');

      const normalized = source.replace(/\r\n/g, '\n');

      let replaced = false;
      let output = normalized;

      for (const pattern of LEGACY_BASE_DIR_PATTERNS) {
        if (pattern.test(output)) {
          output = output.replace(pattern, PORTABLE_BASE_DIR);
          replaced = true;
          break;
        }
      }

      if (!replaced) {
        console.warn(`[moonwolf-portable-server] BASE_DIR antigua no encontrada en ${path.basename(args.path)}; se deja el archivo tal cual.`);
        return { contents: normalized, loader: 'js' };
      }

      console.log(`[moonwolf-portable-server] BASE_DIR portabilizada en ${path.basename(args.path)}`
      );
      return { contents: output, loader: 'js' };
    });
  },
};

async function main() {
  await esbuild.build({
    entryPoints: ['agent/index.js'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: 'dist/agent.cjs',
    plugins: [portableServerPlugin],
    logLevel: 'info',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
