import type { UndoManager } from 'yjs'

type SheetUndo = { manager: UndoManager; dispose(): void }
export const workbookUndo = new WeakMap<HTMLElement, Map<string, SheetUndo>>()
