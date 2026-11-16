import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { preprocessCSS, resolveConfig } from 'vite'

const ROOT = resolve(import.meta.dirname, '..')

const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

function createPluginCssEsbuildPlugin(moduleId, packageRoot, viteConfig) {
  return {
    name: 'dsh-plugin-css',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const raw = await readFile(args.path, 'utf8')
        const result = await preprocessCSS(raw, args.path, viteConfig)
        const rel = relative(packageRoot, args.path).replace(/\\/g, '/')
        const tagId = `${moduleId}:${rel}`
        const modules = result.modules ?? {}
        const contents = [
          `const tagId = ${JSON.stringify(tagId)};`,
          `const cssText = ${JSON.stringify(result.code)};`,
          `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
          `  const tag = document.createElement('style');`,
          `  tag.dataset.pluginCss = tagId;`,
          `  tag.textContent = cssText;`,
          `  document.head.appendChild(tag);`,
          `}`,
          `export default ${JSON.stringify(modules)};`,
        ].join('\n')
        return { contents, loader: 'js' }
      })
    },
  }
}

async function bundleClientPlugin() {
  const viteConfig = await resolveConfig({ configFile: false }, 'build')
  const moduleId = 'dsh-codex-portal'
  const result = await esbuild.build({
    entryPoints: [resolve(ROOT, 'src/client/index.tsx')],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: PLATFORM_EXTERNALS,
    plugins: [createPluginCssEsbuildPlugin(moduleId, ROOT, viteConfig)],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  })

  const output = result.outputFiles?.[0]
  if (!output) throw new Error(`build-client: no output emitted for ${moduleId}`)

  const wrapped = [
    `window.__ModuleLoader__.load({id:${JSON.stringify(moduleId)},factory:require=>{var module={exports:{}};var exports=module.exports;`,
    output.text,
    `return module.exports}});`,
    '',
  ].join('\n')

  const destination = resolve(ROOT, 'dist/client.js')
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, wrapped, 'utf8')
}

bundleClientPlugin().catch((error) => {
  console.error(error)
  process.exit(1)
})
