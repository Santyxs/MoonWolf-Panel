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
