const { contextBridge, ipcRenderer } = require('electron')

function toIpcSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, currentValue) => {
    if (typeof currentValue === 'bigint') return currentValue.toString()
    if (typeof currentValue === 'function' || typeof currentValue === 'symbol' || typeof currentValue === 'undefined') return null
    return currentValue
  }))
}

contextBridge.exposeInMainWorld('electronAPI', {
  runAgent: (payload) => ipcRenderer.invoke('agent:run', toIpcSafe(payload)),
  cancelAgentRun: (payload) => ipcRenderer.invoke('agent:cancel', toIpcSafe(payload)),
  cancelAgentTool: (payload) => ipcRenderer.invoke('agent:cancel-tool', toIpcSafe(payload)),
  respondToApproval: (payload) => ipcRenderer.invoke('agent:approval-response', toIpcSafe(payload)),
  previewFile: (payload) => ipcRenderer.invoke('file:preview', toIpcSafe(payload)),
  getGitHubStatus: (payload) => ipcRenderer.invoke('github:status', toIpcSafe(payload)),
  startGitHubLogin: (payload) => ipcRenderer.invoke('github:login', toIpcSafe(payload)),
  onAgentUpdate: (callback) => {
    ipcRenderer.on('agent:update', (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners('agent:update')
  },
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
})
