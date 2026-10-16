import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./contracts";

const api: DesktopBridge = {
  snapshot: () => ipcRenderer.invoke("agent:snapshot"),
  act: (action) => ipcRenderer.invoke("agent:action", action),
  subscribe(listener) {
    const changed = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on("agent:state", changed);
    return () => ipcRenderer.removeListener("agent:state", changed);
  },
};
contextBridge.exposeInMainWorld("printAgent", api);
