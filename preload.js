const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dialogTitleBridge', {
  setTitle: (title) => ipcRenderer.sendSync('set-dialog-title', title),
});
