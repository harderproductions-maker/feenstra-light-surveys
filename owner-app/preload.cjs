const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ownerApp', { request: (input) => ipcRenderer.invoke('owner:request', input) });
