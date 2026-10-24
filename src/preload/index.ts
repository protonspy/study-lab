import { contextBridge, ipcRenderer } from "electron"
import { API_METHODS, type Api, type Bridge, type MainEvent } from "@shared/api"

const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke("api", m, ...args)])) as unknown as Api

const bridge: Bridge = {
  api,
  onEvent(fn) {
    const listener = (_: unknown, e: MainEvent) => fn(e)
    ipcRenderer.on("event", listener)
    return () => {
      ipcRenderer.removeListener("event", listener)
    }
  },
}

contextBridge.exposeInMainWorld("studyLab", bridge)
