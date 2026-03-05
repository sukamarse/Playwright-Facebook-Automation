'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // ── Profile management ──────────────────────────────
    getProfiles:       ()             => ipcRenderer.invoke('get-profiles'),
    saveProfile:       (name, proxy, minPost, maxPost) => ipcRenderer.invoke('save-profile', name, proxy, minPost, maxPost),
    deleteProfile:     (name)         => ipcRenderer.invoke('delete-profile', name),
    updateProfileImage:(name, imgPath)=> ipcRenderer.invoke('update-profile-image', name, imgPath),
    updateProfileDelay:(name, min, max) => ipcRenderer.invoke('update-profile-delay', name, min, max),
    selectImage:       ()             => ipcRenderer.invoke('select-image'),

    // ── Bot control ─────────────────────────────────────
    startBot:  (config)      => ipcRenderer.send('start-bot', config),
    stopBot:   ()            => ipcRenderer.send('stop-bot'),
    openManual:(config)      => ipcRenderer.send('open-manual', config),
    pauseProfile: (name)     => ipcRenderer.send('pause-profile', name),
    resumeProfile:(name)     => ipcRenderer.send('resume-profile', name),

    // ── Utilities ────────────────────────────────────────
    openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
    getDataPath:   () => ipcRenderer.invoke('get-data-path'),

    // ── Events (UI listeners) ───────────────────────────
    onLog:          (cb) => ipcRenderer.on('log-message',    (_e, msg)             => cb(msg)),
    onStateChange:  (cb) => ipcRenderer.on('state-change',   (_e, isRunning)       => cb(isRunning)),
    onProfileStatus:(cb) => ipcRenderer.on('profile-status', (_e, { profileName, status }) => cb(profileName, status)),

    // Cleanup helper (call when component unmounts / window reloads)
    removeAllListeners: () => {
        ['log-message', 'state-change', 'profile-status'].forEach(ch => ipcRenderer.removeAllListeners(ch));
    }
});