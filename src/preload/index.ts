import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

type HostResult = { host?: string; ok?: boolean; error?: string }

// The whole surface the page gets. Every call names one specific action; there is no generic "run" channel.
const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  // Where a file dropped on a terminal lives on disk (Electron no longer puts this on File objects).
  pathFor: (file: File): string => webUtils.getPathForFile(file),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, state: unknown) => cb(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  },

  open: (id: string): Promise<HostResult> => ipcRenderer.invoke('session:open', id),
  newSession: (projectId: number): Promise<HostResult> => ipcRenderer.invoke('session:new', projectId),
  resume: (id: string): Promise<HostResult> => ipcRenderer.invoke('session:resume', id),
  move: (id: string): Promise<HostResult> => ipcRenderer.invoke('session:move', id),
  end: (id: string): Promise<boolean> => ipcRenderer.invoke('session:end', id),
  rename: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke('session:rename', id, name),
  pin: (id: string, pinned: boolean): Promise<boolean> => ipcRenderer.invoke('session:pin', id, pinned),
  setSummaries: (on: boolean): Promise<boolean> => ipcRenderer.invoke('summaries:set', on),
  setNote: (target: string, body: string): Promise<boolean> => ipcRenderer.invoke('note:set', target, body),

  attach: (name: string, cols: number, rows: number): Promise<boolean> => ipcRenderer.invoke('term:attach', name, cols, rows),
  input: (name: string, data: string) => ipcRenderer.send('term:input', name, data),
  resize: (name: string, cols: number, rows: number) => ipcRenderer.send('term:resize', name, cols, rows),
  scroll: (name: string, lines: number) => ipcRenderer.send('term:scroll', name, lines),
  detach: (name: string) => ipcRenderer.send('term:detach', name),
  onTermData: (cb: (name: string, data: string) => void) => {
    const listener = (_e: IpcRendererEvent, name: string, data: string) => cb(name, data)
    ipcRenderer.on('term:data', listener)
    return () => ipcRenderer.removeListener('term:data', listener)
  },
  onTermExit: (cb: (name: string) => void) => {
    const listener = (_e: IpcRendererEvent, name: string) => cb(name)
    ipcRenderer.on('term:exit', listener)
    return () => ipcRenderer.removeListener('term:exit', listener)
  }
}

contextBridge.exposeInMainWorld('mason', api)

export type MasonApi = typeof api
