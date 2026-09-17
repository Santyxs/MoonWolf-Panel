import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);
const agentDir = path.join(root, 'agent');
const require = createRequire(path.join(agentDir, 'package.json'));
const { build } = require('esbuild');
const outDir = path.join(root, 'dist');

fs.mkdirSync(outDir, { recursive: true });

const legacyBaseDir = String.raw`const BASE_DIR    = 'C:\Users\HP\Desktop\Proyectos\Minecraft Servers\MoonWolf';`;
const portableBaseDir = `const BASE_DIR = process.env.MOONWOLF_SERVER_DIR || path.join(
  process.env.USERPROFILE || process.env.HOME || process.cwd(),
  'MoonWolf',
);`;

const legacyPort = 'const PORT        = 3000;';
const portablePort = "const PORT = Number(process.env.MOONWOLF_PORT || 3000);";

const portableServerPlugin = {
  name: 'moonwolf-portable-server',
  setup(buildApi) {
    buildApi.onLoad({ filter: /(?:^|[/\\])server\.js$/ }, async args => {
      let source = await fs.promises.readFile(args.path, 'utf8');

      if (!source.includes(legacyBaseDir)) {
        throw new Error('No se encontró la BASE_DIR antigua de server.js para convertirla a portable.');
      }
      source = source.replace(legacyBaseDir, portableBaseDir);
      source = source.replace(legacyPort, portablePort);
      source = source.replace(
        'server.listen(PORT, () => console.log(`MoonWolf Panel → http://localhost:${PORT}`));',
        "server.listen(PORT, '127.0.0.1', () => console.log(`MoonWolf Panel → http://127.0.0.1:${PORT}`));",
      );

      return { contents: source, loader: 'js' };
    });
  },
};

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
  plugins: [portableServerPlugin],
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
