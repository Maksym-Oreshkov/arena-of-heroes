import { contextBridge } from 'electron'

// Экспортируем минимальный API (расширите при необходимости)
contextBridge.exposeInMainWorld('appInfo', {
  name: 'My Arena Game',
})

