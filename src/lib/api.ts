/** Typed wrappers around the Rust commands. */
import { invoke } from '@tauri-apps/api/core';

export interface DocEntry {
  path: string;
  name: string;
  rel: string;
  dir: string;
  size: number;
}

export interface SearchHit {
  path: string;
  name: string;
  rel: string;
  line: number;
  text: string;
  start: number;
  end: number;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  files_scanned: number;
}

export const scanFolder = (root: string): Promise<DocEntry[]> =>
  invoke('scan_folder', { root });

export const readDocument = (path: string): Promise<string> =>
  invoke('read_document', { path });

export const searchDocuments = (
  root: string, query: string, limit?: number,
): Promise<SearchResult> =>
  invoke('search_documents', { root, query, limit: limit ?? null });

export const pickFolder = (): Promise<string | null> =>
  invoke('pick_folder');

/**
 * A document named on the command line at startup (file association, or a path
 * passed to the exe). Returned once: the Rust side takes rather than reads the
 * value so a page reload does not reopen the same file.
 */
export const takePendingOpen = (): Promise<string | null> =>
  invoke('take_pending_open');

/** Payload of the `open-file` event, emitted on every launch after the first. */
export interface OpenFileEvent {
  path: string;
  /** Parent directory, canonicalised, or null if it could not be resolved. */
  folder: string | null;
}
