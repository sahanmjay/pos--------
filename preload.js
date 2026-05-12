const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronDB', {
  getSales: (filters) => ipcRenderer.invoke('db:query', {
    table: 'sales',
    action: 'getAll',
    filters
  }),
  saveShiftClosure: (data) => ipcRenderer.invoke('db:query', {
    table: 'shift_closures',
    action: 'insert',
    data
  }),
  getShiftClosures: () => ipcRenderer.invoke('db:query', {
    table: 'shift_closures',
    action: 'getAll'
  })
});
