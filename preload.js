const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    startBot: (config) => ipcRenderer.send('start-bot', config),
    stopBot: () => ipcRenderer.send('stop-bot'),
    getProfiles: () => ipcRenderer.invoke('get-profiles'),
    saveProfile: (name, proxyObj) => ipcRenderer.invoke('save-profile', name, proxyObj),
    deleteProfile: (name) => ipcRenderer.invoke('delete-profile', name),
    selectImage: () => ipcRenderer.invoke('select-image'),
    updateProfileImage: (name, imagePath) => ipcRenderer.invoke('update-profile-image', name, imagePath), // Dòng mới thêm
    
    onLog: (callback) => ipcRenderer.on('log-message', (event, msg) => callback(msg)),
    onStateChange: (callback) => ipcRenderer.on('state-change', (event, isRunning) => callback(isRunning))
});