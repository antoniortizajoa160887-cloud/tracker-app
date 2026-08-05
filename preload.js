const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dialogTitleBridge', {
  setTitle: (title) => ipcRenderer.sendSync('set-dialog-title', title),
});

contextBridge.exposeInMainWorld('__nativePromptBridge', {
  // Electron does not implement window.prompt() at all, so this asks the
  // main process to show a real native input box (blocks until answered).
  prompt: (message, defaultValue) => ipcRenderer.sendSync('native-prompt', message, defaultValue),
});
