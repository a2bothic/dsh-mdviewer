//! File-system backend for the Markdown viewer.
//!
//! Exposes three commands to the front end: scan a folder for documents,
//! read one document, and run a full-text search across a folder. All path
//! handling and all I/O stay in Rust so the webview never touches the disk
//! directly.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Extensions treated as readable documents.
const DOC_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx", "txt"];

/// Directories that are never worth scanning.
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt",
    ".venv", "venv", "__pycache__", ".cache", ".idea", ".vscode", "vendor",
];

/// Guard against pathological trees.
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 24;

#[derive(Serialize)]
pub struct DocEntry {
    path: String,
    name: String,
    /// Path relative to the scanned root, for display.
    rel: String,
    /// Directory portion of `rel`, empty at the root.
    dir: String,
    size: u64,
}

#[derive(Serialize)]
pub struct SearchHit {
    path: String,
    name: String,
    rel: String,
    line: usize,
    /// The matching line, trimmed for display.
    text: String,
    /// Byte range of the match inside `text`, for highlighting.
    start: usize,
    end: usize,
}

#[derive(Serialize)]
pub struct SearchResult {
    hits: Vec<SearchHit>,
    /// True when the scan stopped early at a limit.
    truncated: bool,
    files_scanned: usize,
}

fn is_doc(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| DOC_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') && name != "."
        || SKIP_DIRS.contains(&name)
}

/// Turn a path into a lossy UTF-8 string; non-UTF-8 paths are skipped rather
/// than silently mangled.
fn path_str(p: &Path) -> Option<String> {
    p.to_str().map(|s| s.to_string())
}

#[tauri::command]
fn scan_folder(root: String) -> Result<Vec<DocEntry>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("Not a directory: {root}"));
    }

    let mut out = Vec::new();
    let walker = WalkDir::new(&root_path)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Always descend into the root itself.
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_dir() && should_skip_dir(&name))
        });

    for entry in walker.flatten() {
        if out.len() >= MAX_FILES {
            break;
        }
        if !entry.file_type().is_file() || !is_doc(entry.path()) {
            continue;
        }
        let Some(full) = path_str(entry.path()) else { continue };
        let rel = entry
            .path()
            .strip_prefix(&root_path)
            .ok()
            .and_then(path_str)
            .unwrap_or_else(|| full.clone());
        let rel_norm = rel.replace('\\', "/");
        let dir = match rel_norm.rfind('/') {
            Some(i) => rel_norm[..i].to_string(),
            None => String::new(),
        };
        out.push(DocEntry {
            path: full,
            name: entry.file_name().to_string_lossy().to_string(),
            rel: rel_norm,
            dir,
            size: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }

    // Sort by relative path so the tree order is stable across platforms.
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn read_document(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Not a file: {path}"));
    }
    // Refuse absurdly large files rather than freezing the webview.
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "File is too large to open ({:.1} MB, limit {} MB)",
            meta.len() as f64 / 1_048_576.0,
            MAX_BYTES / 1_048_576
        ));
    }
    fs::read_to_string(&p).map_err(|e| format!("Could not read {path}: {e}"))
}

/// Case-insensitive substring search across every document under `root`.
#[tauri::command]
fn search_documents(root: String, query: String, limit: Option<usize>) -> Result<SearchResult, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("Not a directory: {root}"));
    }
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(SearchResult { hits: Vec::new(), truncated: false, files_scanned: 0 });
    }
    let cap = limit.unwrap_or(500);
    let mut hits = Vec::new();
    let mut truncated = false;
    let mut files_scanned = 0usize;

    let walker = WalkDir::new(&root_path)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_dir() && should_skip_dir(&name))
        });

    'outer: for entry in walker.flatten() {
        if !entry.file_type().is_file() || !is_doc(entry.path()) {
            continue;
        }
        // Skip files that are too large to search cheaply.
        if entry.metadata().map(|m| m.len() > 4 * 1024 * 1024).unwrap_or(true) {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else { continue };
        files_scanned += 1;

        let Some(full) = path_str(entry.path()) else { continue };
        let rel = entry
            .path()
            .strip_prefix(&root_path)
            .ok()
            .and_then(path_str)
            .unwrap_or_else(|| full.clone())
            .replace('\\', "/");
        let name = entry.file_name().to_string_lossy().to_string();

        for (i, line) in text.lines().enumerate() {
            let lower = line.to_lowercase();
            let Some(pos) = lower.find(&needle) else { continue };

            // Build a display window around the match, measured in chars so
            // the highlight offsets stay valid for the front end.
            let chars: Vec<char> = line.chars().collect();
            let match_start_chars = line[..pos].chars().count();
            let match_len = query.trim().chars().count();

            const PAD: usize = 40;
            let win_start = match_start_chars.saturating_sub(PAD);
            let win_end = (match_start_chars + match_len + PAD).min(chars.len());

            let mut display: String = chars[win_start..win_end].iter().collect();
            let mut start = match_start_chars - win_start;
            if win_start > 0 {
                display.insert(0, '…');
                start += 1;
            }
            if win_end < chars.len() {
                display.push('…');
            }
            let end = (start + match_len).min(display.chars().count());

            hits.push(SearchHit {
                path: full.clone(),
                name: name.clone(),
                rel: rel.clone(),
                line: i + 1,
                text: display,
                start,
                end,
            });

            if hits.len() >= cap {
                truncated = true;
                break 'outer;
            }
        }
    }

    Ok(SearchResult { hits, truncated, files_scanned })
}

/// Open a folder picker through the dialog plugin and return the choice.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Choose a folder of Markdown documents")
        .pick_folder(move |p| {
            let _ = tx.send(p);
        });
    let picked = rx.recv().map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).and_then(|p| path_str(&p)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            read_document,
            search_documents,
            pick_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running dsh-mdviewer");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mdviewer-test-{name}"));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn scans_only_documents_and_skips_ignored_dirs() {
        let root = tmpdir("scan");
        fs::write(root.join("a.md"), "# a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        fs::write(root.join("c.png"), "binary").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/d.markdown"), "# d").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/e.md"), "# e").unwrap();

        let got = scan_folder(root.to_str().unwrap().to_string()).unwrap();
        let names: Vec<_> = got.iter().map(|d| d.name.as_str()).collect();

        assert!(names.contains(&"a.md"), "md file missing: {names:?}");
        assert!(names.contains(&"b.txt"), "txt file missing: {names:?}");
        assert!(names.contains(&"d.markdown"), "nested file missing: {names:?}");
        assert!(!names.contains(&"c.png"), "png should be excluded");
        assert!(!names.contains(&"e.md"), "node_modules should be skipped");

        // Relative paths and directory grouping must be populated.
        let d = got.iter().find(|d| d.name == "d.markdown").unwrap();
        assert_eq!(d.dir, "sub");
        assert_eq!(d.rel.replace('\\', "/"), "sub/d.markdown");
    }

    #[test]
    fn scan_rejects_non_directory() {
        assert!(scan_folder("/definitely/not/here".into()).is_err());
    }

    #[test]
    fn reads_document_and_rejects_missing() {
        let root = tmpdir("read");
        let f = root.join("x.md");
        fs::write(&f, "# hello").unwrap();
        assert_eq!(read_document(f.to_str().unwrap().into()).unwrap(), "# hello");
        assert!(read_document(root.join("nope.md").to_str().unwrap().into()).is_err());
        assert!(read_document(root.to_str().unwrap().into()).is_err());
    }

    #[test]
    fn search_finds_matches_and_reports_line_numbers() {
        let root = tmpdir("search");
        fs::write(root.join("one.md"), "alpha\nneedle here\nomega\n").unwrap();
        fs::write(root.join("two.md"), "nothing\n").unwrap();

        let r = search_documents(root.to_str().unwrap().into(), "needle".into(), None).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].line, 2);
        assert_eq!(r.files_scanned, 2);

        // The highlight offsets must actually select the match.
        let h = &r.hits[0];
        let chars: Vec<char> = h.text.chars().collect();
        let selected: String = chars[h.start..h.end].iter().collect();
        assert_eq!(selected.to_lowercase(), "needle", "text={:?}", h.text);
    }

    #[test]
    fn search_is_case_insensitive_and_matches_cjk() {
        let root = tmpdir("search-cjk");
        fs::write(root.join("z.md"), "中文内容包含关键词的段落\n").unwrap();
        let r = search_documents(root.to_str().unwrap().into(), "关键词".into(), None).unwrap();
        assert_eq!(r.hits.len(), 1);
        let h = &r.hits[0];
        let chars: Vec<char> = h.text.chars().collect();
        let selected: String = chars[h.start..h.end].iter().collect();
        assert_eq!(selected, "关键词", "text={:?}", h.text);

        let upper = search_documents(root.to_str().unwrap().into(), "ABC".into(), None).unwrap();
        assert_eq!(upper.hits.len(), 0);
    }

    #[test]
    fn search_highlights_correctly_on_long_lines() {
        let root = tmpdir("search-long");
        let line = format!("{}{}{}", "x".repeat(200), "TARGET", "y".repeat(200));
        fs::write(root.join("long.md"), format!("{line}\n")).unwrap();
        let r = search_documents(root.to_str().unwrap().into(), "TARGET".into(), None).unwrap();
        assert_eq!(r.hits.len(), 1);
        let h = &r.hits[0];
        let chars: Vec<char> = h.text.chars().collect();
        let selected: String = chars[h.start..h.end].iter().collect();
        assert_eq!(selected, "TARGET");
        assert!(h.text.starts_with('…'), "expected left ellipsis: {:?}", h.text);
        assert!(h.text.ends_with('…'), "expected right ellipsis: {:?}", h.text);
    }

    #[test]
    fn search_respects_the_limit() {
        let root = tmpdir("search-limit");
        let mut body = String::new();
        for _ in 0..50 { body.push_str("needle\n"); }
        fs::write(root.join("many.md"), body).unwrap();
        let r = search_documents(root.to_str().unwrap().into(), "needle".into(), Some(10)).unwrap();
        assert_eq!(r.hits.len(), 10);
        assert!(r.truncated);
    }

    #[test]
    fn empty_query_returns_nothing() {
        let root = tmpdir("search-empty");
        fs::write(root.join("a.md"), "text\n").unwrap();
        let r = search_documents(root.to_str().unwrap().into(), "   ".into(), None).unwrap();
        assert!(r.hits.is_empty());
    }
}
