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
  setApprovalPolicy: (payload) => ipcRenderer.invoke('agent:set-approval-policy', toIpcSafe(payload)),
  getChangeBatch: (payload) => ipcRenderer.invoke('change-batch:get', toIpcSafe(payload)),
  setChangeBatch: (payload) => ipcRenderer.invoke('change-batch:set', toIpcSafe(payload)),
  approveChangeBatch: (payload) => ipcRenderer.invoke('change-batch:approve', toIpcSafe(payload)),
  cancelChangeBatch: (payload) => ipcRenderer.invoke('change-batch:cancel', toIpcSafe(payload)),
  getRunSnapshot: (payload) => ipcRenderer.invoke('run-snapshot:get', toIpcSafe(payload)),
  undoRunSnapshot: (payload) => ipcRenderer.invoke('run-snapshot:undo', toIpcSafe(payload)),
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
