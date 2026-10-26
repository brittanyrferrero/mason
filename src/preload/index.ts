import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { FoundView } from '../main/state'

type HostResult = { host?: string; ok?: boolean; error?: string }

// The whole surface the page gets. Every call names one specific action; there is no generic "run" channel.
const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  getWindows: (): Promise<{ host: string; sid: string | null }[] | null> => ipcRenderer.invoke('windows:get'),
  setWindows: (list: { host: string; sid: string | null }[]): Promise<boolean> => ipcRenderer.invoke('windows:set', list),
  // Where a file dropped on a terminal lives on disk (Electron no longer puts this on File objects).
  pathFor: (file: File): string => webUtils.getPathForFile(file),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, state: unknown) => cb(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  },

  open: (id: string): Promise<HostResult> => ipcRenderer.invoke('session:open', id),
  newSession: (projectId: number): Promise<HostResult> => ipcRenderer.invoke('session:new', projectId),
  newTerminal: (projectId: number): Promise<HostResult> => ipcRenderer.invoke('terminal:new', projectId),
  terminalHere: (name: string): Promise<HostResult> => ipcRenderer.invoke('terminal:here', name),
  addProject: (): Promise<{ projectId?: number; error?: string }> => ipcRenderer.invoke('project:add'),
  forgetProject: (id: number): Promise<boolean> => ipcRenderer.invoke('project:forget', id),
  resume: (id: string): Promise<HostResult> => ipcRenderer.invoke('session:resume', id),
  fresh: (id: string): Promise<HostResult> => ipcRenderer.invoke('session:fresh', id),
  editHandoff: (id: string, brief: string): Promise<boolean> => ipcRenderer.invoke('handoff:edit', id, brief),
  move: (id: string): Promise<HostResult> => ipcRenderer.invoke('session:move', id),
  end: (id: string): Promise<boolean> => ipcRenderer.invoke('session:end', id),
  rename: (id: string, name: string): Promise<boolean> => ipcRenderer.invoke('session:rename', id, name),
  pin: (id: string, pinned: boolean): Promise<boolean> => ipcRenderer.invoke('session:pin', id, pinned),
  moveTo: (id: string, projectId: number): Promise<boolean> => ipcRenderer.invoke('session:move-to', id, projectId),
  renameProject: (id: number, name: string): Promise<boolean> => ipcRenderer.invoke('project:rename', id, name),
  star: (id: string, starred: boolean): Promise<boolean> => ipcRenderer.invoke('session:star', id, starred),
  search: (query: string): Promise<FoundView[]> => ipcRenderer.invoke('session:search', query),
  setSummaries: (on: boolean): Promise<boolean> => ipcRenderer.invoke('summaries:set', on),
  setWorktrees: (on: boolean): Promise<boolean> => ipcRenderer.invoke('worktrees:set', on),
  setNotify: (on: boolean): Promise<boolean> => ipcRenderer.invoke('notify:set', on),
  setClaudeAuto: (on: boolean): Promise<boolean> => ipcRenderer.invoke('claudeAuto:set', on),
  setModel: (id: string, model: string): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('session:model', id, model),
  spinoff: (fromHost: string, thought: string): Promise<HostResult> => ipcRenderer.invoke('session:spinoff', fromHost, thought),
  lastCopy: (): Promise<{ text: string; at: number } | null> => ipcRenderer.invoke('copy:last'),
  // A spin-off started (from /spinoff in Claude, or ⌘⇧N): open its window beside the one it came from.
  onSpunoff: (cb: (host: string, from: string | null) => void) => {
    const listener = (_e: IpcRendererEvent, host: string, from: string | null) => cb(host, from)
    ipcRenderer.on('mason:spunoff', listener)
    return () => {
      ipcRenderer.removeListener('mason:spunoff', listener)
    }
  },
  setNote: (target: string, body: string): Promise<boolean> => ipcRenderer.invoke('note:set', target, body),
  removeSaved: (id: number): Promise<boolean> => ipcRenderer.invoke('saved:remove', id),
  checkUpdate: (): Promise<{ count: number; notes: string[] } | null> => ipcRenderer.invoke('update:check'),
  runUpdate: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('update:run'),

  // Sent by the menu bar: peek at a waiting session, or show a one-off message.
  onPeek: (cb: (target: { host: string; id: string } | null, id: string) => void) => {
    const listener = (_e: IpcRendererEvent, target: { host: string; id: string } | null, id: string) => cb(target, id)
    ipcRenderer.on('mason:peek', listener)
    return () => {
      ipcRenderer.removeListener('mason:peek', listener)
    }
  },
  onNotice: (cb: (text: string) => void) => {
    const listener = (_e: IpcRendererEvent, text: string) => cb(text)
    ipcRenderer.on('mason:notice', listener)
    return () => {
      ipcRenderer.removeListener('mason:notice', listener)
    }
  },

  // Quick capture (its own little window).
  captureSave: (text: string): Promise<boolean> => ipcRenderer.invoke('capture:save', text),
  captureClose: () => ipcRenderer.send('capture:close'),
  onCaptureShow: (cb: (from: string | null) => void) => {
    const listener = (_e: IpcRendererEvent, from: string | null) => cb(from)
    ipcRenderer.on('capture:show', listener)
    return () => {
      ipcRenderer.removeListener('capture:show', listener)
    }
  },

  attach: (name: string, cols: number, rows: number): Promise<boolean> => ipcRenderer.invoke('term:attach', name, cols, rows),
  input: (name: string, data: string) => ipcRenderer.send('term:input', name, data),
  resize: (name: string, cols: number, rows: number) => ipcRenderer.send('term:resize', name, cols, rows),
  scroll: (name: string, lines: number) => ipcRenderer.send('term:scroll', name, lines),
  dragScroll: (name: string, lines: number) => ipcRenderer.send('term:dragScroll', name, lines),
  selecting: (name: string) => ipcRenderer.send('term:selecting', name),
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
