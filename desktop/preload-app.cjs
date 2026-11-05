const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  saveReportPdf: (report) => ipcRenderer.invoke('reports:save', report),
  openQuoteEmail: (url) => ipcRenderer.invoke('quotes:open-email', url)
});
