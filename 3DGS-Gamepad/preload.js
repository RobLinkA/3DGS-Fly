// ============================================================
// 3DGS-Gamepad —— preload script
// ------------------------------------------------------------
// Exposes two narrow bridges to the sandboxed renderer:
//   window.gamepadApi.saveFile(payload) -> native save dialog
//   window.rcApi.getStatus()            -> RC-N1 connection status
//   window.rcApi.onState(callback)      -> subscribe to RC-N1 stick state
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gamepadApi', {
    /**
     * Ask the main process to show a native save dialog and write the
     * payload bytes to the chosen path.
     *
     * @param {{ data: ArrayBuffer, type: string, suggestedName: string }} payload
     * @returns {Promise<boolean>} true when saved, false when cancelled/failed
     */
    saveFile: (payload) => ipcRenderer.invoke('save-video', payload)
});

contextBridge.exposeInMainWorld('rcApi', {
    /**
     * Query current RC-N1 connection status.
     * @returns {Promise<{connected: boolean, port: string}>}
     */
    getStatus: () => ipcRenderer.invoke('rc:getStatus'),

    /**
     * Subscribe to RC-N1 stick state pushed from the main process.
     * @param {(data: {connected: boolean, port: string, state: object|null}) => void} callback
     * @returns {() => void} unsubscribe function
     */
    onState: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('rc:state', handler);
        return () => ipcRenderer.removeListener('rc:state', handler);
    }
});
