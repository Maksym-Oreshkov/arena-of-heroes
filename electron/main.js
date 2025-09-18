import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isProd = app.isPackaged || process.env.NODE_ENV === 'production'

let viteServer = null
let mainWindow = null

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#151515',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (!isProd) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  if (!isProd) {
    // Dev: стартуем Vite программно и грузим его URL
    const { createServer } = await import('vite')
    viteServer = await createServer({
      configFile: path.resolve(process.cwd(), 'vite.config.js'),
      server: { host: 'localhost' },
    })
    await viteServer.listen()

    const urls = viteServer.resolvedUrls?.local ?? []
    const devUrl = urls[0] || 'http://localhost:5173'
    await mainWindow.loadURL(devUrl)
  } else {
    // Prod: грузим собранный index.html из dist (рядом с electron/ в пакете)
    const indexHtml = fileURLToPath(new URL('../dist/index.html', import.meta.url))
    await mainWindow.loadFile(indexHtml)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.on('window-all-closed', () => {
  // На macOS обычно не выходим, пока пользователь явно не закроет
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow()
  }
})

app.on('before-quit', async () => {
  if (viteServer) {
    try { await viteServer.close() } catch {}
    viteServer = null
  }
})

app.whenReady().then(createWindow)
