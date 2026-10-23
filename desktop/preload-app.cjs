const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  saveReportPdf: (report) => ipcRenderer.invoke('reports:save', report)
});
