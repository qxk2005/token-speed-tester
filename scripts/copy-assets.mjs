import { copyFile, cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcTemplatePath = resolve(rootDir, 'src', 'template.html')
const distDir = resolve(rootDir, 'dist')
const distTemplatePath = resolve(distDir, 'template.html')
const srcPublicDir = resolve(rootDir, 'src', 'public')
const distPublicDir = resolve(distDir, 'public')

await mkdir(distDir, { recursive: true })
await copyFile(srcTemplatePath, distTemplatePath)
// 复制 WebUI 静态资源，使打包后的 server 能托管页面（供 --restart 使用）
await cp(srcPublicDir, distPublicDir, { recursive: true })
