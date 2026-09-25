import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { WorkspaceTypertGenerator } from '../../typert/generator/lib/types/workspace.js'

/**
 * Host library and FaceModel artifacts for the `remoteServers` namespace only.
 * The generic package-mode plugin
 * analyzes every contributor before filtering its output.
 */
export default defineConfig({
  name: '@deepseek-ai/dsh-api-remote-servers',
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [{
    name: 'remote-servers-typert',
    writeBundle() {
      const root = resolve(import.meta.dirname, '../../..')
      const generator = new WorkspaceTypertGenerator(root)
      const artifacts = generator.generate(['@deepseek-ai/dsh-api-remote-servers'], ['host'])
      for (const artifact of artifacts) {
        const output = resolve(root, artifact.packageRoot, 'lib')
        writeFileSync(resolve(output, `typert.${artifact.face}.js`), artifact.js)
        writeFileSync(resolve(output, `typert.${artifact.face}.d.ts`), artifact.dts)
        if (artifact.remote !== undefined) {
          writeFileSync(resolve(output, 'typert.remote-client.js'), artifact.remote.js)
          writeFileSync(resolve(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
          writeFileSync(resolve(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
        }
      }
    },
  }],
})
