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
