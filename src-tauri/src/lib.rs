use base64::Engine;
use notify::Watcher as _;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

/// A file's text plus a cheap change stamp (mtime + size). The frontend keeps
/// the stamp so a later save can detect that the file changed underneath it.
#[derive(Serialize)]
struct FileData {
    content: String,
    stamp: String,
}

/// Recently opened folders, most-recent first. Persisted to the app config dir
/// so the native File ▸ Open Recent submenu survives restarts.
struct Recents(Mutex<Vec<String>>);

/// Handles to the context-sensitive Save / Save As menu items so the frontend
/// can enable/disable them as the active document changes. `enabled` remembers
/// the desired state across menu rebuilds (e.g. when Open Recent changes).
struct MenuState {
    save: Mutex<Option<MenuItem<Wry>>>,
    save_as: Mutex<Option<MenuItem<Wry>>>,
    enabled: Mutex<(bool, bool)>,
}

/// Live filesystem watcher for the open workspace. Dropping it stops watching
/// (and ends its debounce thread, whose channel sender lives inside it).
struct FsWatcher(Mutex<Option<notify::RecommendedWatcher>>);

const MAX_RECENTS: usize = 10;

/// Directories that are never worth showing or searching in a notes app.
/// Applied consistently to the tree, Quick Open and full-text search so that
/// anything visible in the sidebar is also findable.
const JUNK_DIRS: [&str; 8] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "__pycache__",
    ".git",
    "Pods",
];

fn is_junk_dir(name: &str) -> bool {
    JUNK_DIRS.contains(&name)
}

/// True when any segment of `path` *below `root`* is hidden or junk. Only the
/// part inside the workspace is considered — the workspace itself may perfectly
/// well live in `~/.notes`, and that must not silence every event.
fn in_skipped_dir(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).unwrap_or(path).components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        is_junk_dir(&s) || (s.starts_with('.') && s.len() > 1)
    })
}

// ---------------------------------------------------------------- recents

fn recents_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("recents.json"))
}

fn load_recents(app: &tauri::AppHandle) -> Vec<String> {
    recents_file(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        // Drop folders that have since been deleted, renamed or unmounted.
        .filter(|p| Path::new(p).is_dir())
        .collect()
}

fn save_recents(app: &tauri::AppHandle, recents: &[String]) {
    if let (Some(p), Ok(s)) = (recents_file(app), serde_json::to_string(recents)) {
        let _ = fs::write(p, s);
    }
}

// ------------------------------------------------------------------- menu

/// Build (or rebuild) the whole application menu — reading the current recents
/// and Save enable-state from managed state — and install it.
fn rebuild_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let recents = app.state::<Recents>().0.lock().unwrap().clone();
    let (save_on, save_as_on) = *app.state::<MenuState>().enabled.lock().unwrap();

    // App menu (macOS conventions): about, services, hide, quit.
    let app_menu = SubmenuBuilder::new(app, "mad")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let item = |id: &str, label: &str, accel: Option<&str>| -> tauri::Result<MenuItem<Wry>> {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let save = MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .enabled(save_on)
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("save_as", "Save As…")
        .accelerator("CmdOrCtrl+Shift+S")
        .enabled(save_as_on)
        .build(app)?;
    let new_file = item("new_file", "New File", Some("CmdOrCtrl+N"))?;
    let new_folder = item("new_folder", "New Folder", Some("CmdOrCtrl+Shift+N"))?;
    let open_folder = item("open_folder", "Open Folder…", Some("CmdOrCtrl+O"))?;
    let close_tab = item("close_tab", "Close Tab", Some("CmdOrCtrl+W"))?;
    let export_html = item("export_html", "Export as HTML…", None)?;

    let mut recent = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        recent = recent.item(
            &MenuItemBuilder::with_id("recent_none", "No Recent Folders")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for path in &recents {
            let label = path
                .rsplit('/')
                .find(|s| !s.is_empty())
                .unwrap_or(path.as_str());
            recent = recent
                .item(&MenuItemBuilder::with_id(format!("recent::{path}"), label).build(app)?);
        }
        recent = recent
            .separator()
            .item(&MenuItemBuilder::with_id("clear_recents", "Clear Menu").build(app)?);
    }
    let recent = recent.build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_file)
        .item(&new_folder)
        .item(&open_folder)
        .item(&recent)
        .separator()
        .item(&save)
        .item(&save_as)
        .item(&export_html)
        .separator()
        .item(&close_tab)
        .build()?;

    // Edit menu — undo/redo/clipboard plus this app's find commands.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find…", Some("CmdOrCtrl+F"))?)
        .item(&item("find_replace", "Find & Replace…", Some("CmdOrCtrl+Alt+F"))?)
        .item(&item("search_files", "Find in Files…", Some("CmdOrCtrl+Shift+F"))?)
        .separator()
        .item(&item("toggle_spellcheck", "Check Spelling While Typing", None)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&item("quick_open", "Quick Open…", Some("CmdOrCtrl+P"))?)
        .item(&item(
            "command_palette",
            "Command Palette…",
            Some("CmdOrCtrl+Shift+P"),
        )?)
        .separator()
        .item(&item(
            "toggle_source",
            "Toggle Markdown Source",
            Some("CmdOrCtrl+Shift+M"),
        )?)
        .item(&item(
            "toggle_split",
            "Toggle Split Preview",
            Some("CmdOrCtrl+Shift+V"),
        )?)
        .item(&item("toggle_sidebar", "Toggle Sidebar", Some("CmdOrCtrl+\\"))?)
        .separator()
        .item(&item("toggle_theme", "Toggle Light / Dark", None)?)
        .separator()
        .item(&item("zoom_in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item("zoom_out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom_reset", "Actual Size", Some("CmdOrCtrl+0"))?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;

    // Remember the new item handles so set_menu_state can toggle them live.
    let ms = app.state::<MenuState>();
    *ms.save.lock().unwrap() = Some(save);
    *ms.save_as.lock().unwrap() = Some(save_as);
    Ok(())
}

/// Enable/disable the Save and Save As menu items for the active document.
#[tauri::command]
fn set_menu_state(app: tauri::AppHandle, can_save: bool, can_save_as: bool) {
    let ms = app.state::<MenuState>();
    *ms.enabled.lock().unwrap() = (can_save, can_save_as);
    let save = ms.save.lock().unwrap().clone();
    let save_as = ms.save_as.lock().unwrap().clone();
    if let Some(it) = save {
        let _ = it.set_enabled(can_save);
    }
    if let Some(it) = save_as {
        let _ = it.set_enabled(can_save_as);
    }
}

/// Record a folder as recently opened; persists and rebuilds the menu.
#[tauri::command]
fn push_recent(app: tauri::AppHandle, state: tauri::State<Recents>, path: String) {
    let snapshot = {
        let mut recents = state.0.lock().unwrap();
        recents.retain(|p| p != &path);
        recents.insert(0, path);
        recents.truncate(MAX_RECENTS);
        recents.clone()
    };
    save_recents(&app, &snapshot);
    let _ = rebuild_menu(&app);
}

// ------------------------------------------------------------ file system

/// Open the native folder picker and return the chosen directory.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

const SHOWN_EXTS: [&str; 10] = [
    "md", "markdown", "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif",
];

fn shown_ext(path: &Path) -> bool {
    path.extension()
        .map(|e| SHOWN_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            e == "md" || e == "markdown"
        })
        .unwrap_or(false)
}

/// List one level of a directory: subdirectories, markdown files and images.
/// Async so filesystem work stays off the main thread.
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            // metadata() follows symlinks, so linked directories still count.
            let is_dir = fs::metadata(e.path()).ok()?.is_dir();
            if is_dir {
                if is_junk_dir(&name) {
                    return None;
                }
            } else if !shown_ext(&e.path()) {
                return None;
            }
            Some(Entry {
                path: e.path().to_string_lossy().into_owned(),
                name,
                is_dir,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Cheap "has this file changed?" token: modification time plus size.
fn stamp_of(path: &Path) -> String {
    match fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{mtime}:{}", m.len())
        }
        // A missing file has a stable empty stamp, so "deleted then recreated"
        // still reads as a change.
        Err(_) => String::new(),
    }
}

/// Just the change stamp — lets the UI answer "did this file change?" without
/// re-reading its contents on every watcher event (including its own saves).
#[tauri::command]
async fn file_stamp(path: String) -> String {
    stamp_of(Path::new(&path))
}

#[tauri::command]
async fn read_file(path: String) -> Result<FileData, String> {
    let p = Path::new(&path);
    let content = fs::read_to_string(p).map_err(|e| match e.kind() {
        std::io::ErrorKind::InvalidData => "This file isn’t UTF-8 text.".to_string(),
        _ => e.to_string(),
    })?;
    Ok(FileData {
        stamp: stamp_of(p),
        content,
    })
}

/// Marker returned when the on-disk file changed since the frontend read it.
/// The UI recognises this prefix and offers overwrite / reload.
const CONFLICT: &str = "__mad_conflict__";

/// Atomic save: write a temp file, fsync it, then rename over the target, so a
/// failed or interrupted write can never truncate the existing note.
///
/// When `expect` is supplied it must match the file's current stamp; otherwise
/// the write is refused with `CONFLICT` so the user isn't silently clobbered by
/// (or clobbering) an edit made in another app.
#[tauri::command]
async fn write_file(
    path: String,
    content: String,
    expect: Option<String>,
) -> Result<String, String> {
    let target = Path::new(&path);
    if let Some(expected) = expect {
        if stamp_of(target) != expected {
            return Err(CONFLICT.to_string());
        }
    }
    let dir = target.parent().ok_or("Invalid path")?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "note.md".into());
    // Hidden temp name in the same directory (same volume ⇒ rename is atomic).
    let tmp = dir.join(format!(".{name}.mad-tmp"));

    let write = |tmp: &Path| -> std::io::Result<()> {
        let mut f = fs::File::create(tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()
    };
    if let Err(e) = write(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    // Keep the original file's permissions across the replace.
    if let Ok(meta) = fs::metadata(target) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    // Best effort: flush the directory entry so the rename survives a crash.
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(stamp_of(target))
}

fn split_name(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    }
}

fn unique_path(dir: &str, name: &str) -> PathBuf {
    let (stem, ext) = split_name(name);
    let mut candidate = Path::new(dir).join(name);
    let mut n = 2u32;
    while candidate.exists() {
        candidate = Path::new(dir).join(format!("{stem} {n}{ext}"));
        n += 1;
    }
    candidate
}

/// Reduce an arbitrary string to a safe single file name (no separators, no
/// leading dots, never empty).
fn safe_file_name(name: &str, fallback: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned = base
        .replace(['/', '\\', ':'], "_")
        .trim()
        .trim_start_matches('.')
        .to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// Create `name` inside `dir` without clobbering existing files.
/// Returns the path actually created (deduped with " 2", " 3", …).
#[tauri::command]
async fn create_file(dir: String, name: String) -> Result<String, String> {
    let safe = safe_file_name(&name, "Untitled.md");
    let (stem, ext) = split_name(&safe);
    for n in 1..1000u32 {
        let candidate = if n == 1 {
            Path::new(&dir).join(&safe)
        } else {
            Path::new(&dir).join(format!("{stem} {n}{ext}"))
        };
        // create_new is atomic: no TOCTOU window where another writer wins.
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate.to_string_lossy().into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Too many files with that name".into())
}

/// Read an image file as base64 so the webview can show it as a data URL
/// (avoids asset-protocol/webview scheme quirks entirely).
#[tauri::command]
async fn read_image(path: String) -> Result<String, String> {
    const MAX_IMAGE: u64 = 64 * 1024 * 1024;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMAGE {
        return Err("Image is too large to preview".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Save an uploaded image (base64) next to the markdown file.
/// Returns the file name to reference relatively from the document.
#[tauri::command]
async fn save_image(dir: String, name: String, data: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    let safe = safe_file_name(&name, "image.png");
    let target = unique_path(&dir, &safe);
    fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(safe))
}

/// Native Save dialog restricted to markdown. Returns the chosen path with a
/// `.md` extension enforced, or None if cancelled.
#[tauri::command]
async fn save_dialog(
    app: tauri::AppHandle,
    default_name: String,
    dir: Option<String>,
) -> Option<String> {
    let mut builder = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_title("Save Markdown File")
        .set_file_name(&default_name);
    if let Some(d) = dir {
        builder = builder.set_directory(d);
    }
    builder
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| {
            // Append (never rewrite) `.md` — rewriting a foreign extension could
            // collide with a different existing file the native overwrite prompt
            // never checked. `report.notes` → `report.notes.md`, not `report.md`.
            if is_markdown(&p) {
                p.to_string_lossy().into_owned()
            } else {
                let mut s = p.into_os_string();
                s.push(".md");
                s.to_string_lossy().into_owned()
            }
        })
}

/// Native Save dialog for an arbitrary extension (used by Export as HTML).
#[tauri::command]
async fn export_dialog(
    app: tauri::AppHandle,
    default_name: String,
    dir: Option<String>,
    ext: String,
) -> Option<String> {
    let mut builder = app
        .dialog()
        .file()
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .set_title("Export")
        .set_file_name(&default_name);
    if let Some(d) = dir {
        builder = builder.set_directory(d);
    }
    builder
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Native OK/Cancel confirmation. Returns true if the user confirmed.
#[tauri::command]
async fn confirm(app: tauri::AppHandle, title: String, message: String) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show()
}

/// Two-choice confirmation with custom labels (e.g. "Overwrite" / "Reload").
/// Returns true when the first (primary) button is chosen.
#[tauri::command]
async fn confirm_choice(
    app: tauri::AppHandle,
    title: String,
    message: String,
    ok: String,
    cancel: String,
) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok, cancel))
        .blocking_show()
}

/// Informational / error dialog with a single OK button.
#[tauri::command]
async fn message(app: tauri::AppHandle, title: String, message: String, error: bool) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(if error {
            MessageDialogKind::Error
        } else {
            MessageDialogKind::Info
        })
        .blocking_show();
}

/// Rename a file/folder in place. `to` is the full new path. Refuses to
/// overwrite an existing entry.
#[tauri::command]
async fn rename_path(from: String, to: String) -> Result<String, String> {
    if from == to {
        return Ok(to);
    }
    if Path::new(&to).exists() {
        // On a case-insensitive volume (default macOS APFS/HFS+) a case-only
        // rename (Notes.md → notes.md) makes `to` report exists() even though
        // it resolves to the *same* file — allow it. A genuine clash resolves
        // to a different canonical path and is still refused.
        let same_entry = matches!(
            (fs::canonicalize(&from), fs::canonicalize(&to)),
            (Ok(a), Ok(b)) if a == b
        );
        if !same_entry {
            return Err(format!(
                "“{}” already exists",
                Path::new(&to)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| to.clone())
            ));
        }
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(to)
}

/// Move `src` into `dest_dir`. Returns the new path. Refuses to overwrite, and
/// refuses to move a folder inside itself.
#[tauri::command]
async fn move_into(src: String, dest_dir: String) -> Result<String, String> {
    let src_p = Path::new(&src);
    let name = src_p.file_name().ok_or("Invalid source path")?;
    let dest = Path::new(&dest_dir).join(name);
    if src_p.parent() == Some(Path::new(&dest_dir)) {
        return Ok(src.clone()); // already there
    }
    // dest inside src → moving a folder into its own subtree.
    if dest.starts_with(src_p) {
        return Err("Cannot move a folder into itself".into());
    }
    if dest.exists() {
        return Err(format!(
            "“{}” already exists in the destination",
            name.to_string_lossy()
        ));
    }
    fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Create a new subfolder, deduping the name if it already exists.
#[tauri::command]
async fn create_folder(dir: String, name: String) -> Result<String, String> {
    let safe = safe_file_name(&name, "New Folder");
    let target = unique_path(&dir, &safe);
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// Duplicate a file or folder beside itself as "name copy".
#[tauri::command]
async fn duplicate_path(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let dir = p.parent().ok_or("Invalid path")?.to_string_lossy().into_owned();
    let name = p
        .file_name()
        .ok_or("Invalid path")?
        .to_string_lossy()
        .into_owned();
    let (stem, ext) = split_name(&name);
    let target = unique_path(&dir, &format!("{stem} copy{ext}"));
    if p.is_dir() {
        copy_dir(p, &target).map_err(|e| e.to_string())?;
    } else {
        fs::copy(p, &target).map_err(|e| e.to_string())?;
    }
    Ok(target.to_string_lossy().into_owned())
}

/// Move a file/folder to the OS Trash (recoverable) rather than deleting it.
#[tauri::command]
async fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Show the item in Finder / Explorer / the desktop file manager.
#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// Open the item with the OS default application.
#[tauri::command]
async fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------- search / indexing

#[derive(Serialize)]
struct FileHit {
    path: String,
    rel: String,
}

/// A walker that mirrors what the sidebar shows: hidden entries and well-known
/// build/junk directories are skipped, everything else is visible.
fn walker(root: &str) -> ignore::WalkBuilder {
    let mut b = ignore::WalkBuilder::new(root);
    b.hidden(true)
        .parents(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .ignore(false)
        .filter_entry(|e| {
            !e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                || !is_junk_dir(&e.file_name().to_string_lossy())
        });
    b
}

/// Recursively list every markdown/image file under `root` (for Quick Open).
#[tauri::command]
async fn list_all(root: String) -> Result<Vec<FileHit>, String> {
    let root_p = Path::new(&root);
    let mut out = Vec::new();
    for entry in walker(&root).build().flatten() {
        let path = entry.path();
        if path.is_file() && shown_ext(path) {
            let rel = path
                .strip_prefix(root_p)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();
            out.push(FileHit {
                path: path.to_string_lossy().into_owned(),
                rel,
            });
        }
    }
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    Ok(out)
}

#[derive(Serialize)]
struct SearchHit {
    path: String,
    rel: String,
    line: usize,
    text: String,
    start: usize,
    end: usize,
}

#[derive(Serialize)]
struct SearchResult {
    hits: Vec<SearchHit>,
    /// True when the cap was reached and results are partial.
    truncated: bool,
}

/// Full-text search across markdown files under `root`. Results are capped.
#[tauri::command]
async fn search_files(
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<SearchResult, String> {
    if query.trim().is_empty() {
        return Ok(SearchResult {
            hits: vec![],
            truncated: false,
        });
    }
    let mut pattern = if regex {
        query.clone()
    } else {
        regex::escape(&query)
    };
    if whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let re = Arc::new(
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .size_limit(1 << 22)
            .build()
            .map_err(|e| e.to_string())?,
    );
    const MAX_HITS: usize = 800;
    const MAX_FILE: u64 = 2_000_000; // skip huge files
    let root_p = Arc::new(PathBuf::from(&root));
    let hits = Arc::new(Mutex::new(Vec::<SearchHit>::new()));
    let count = Arc::new(AtomicUsize::new(0));

    // Walk + read + match across all cores (ripgrep's parallel walker).
    walker(&root).build_parallel().run(|| {
        let re = Arc::clone(&re);
        let root_p = Arc::clone(&root_p);
        let hits = Arc::clone(&hits);
        let count = Arc::clone(&count);
        Box::new(move |result| {
            use ignore::WalkState;
            if count.load(Ordering::Relaxed) >= MAX_HITS {
                return WalkState::Quit;
            }
            let Ok(entry) = result else {
                return WalkState::Continue;
            };
            let path = entry.path();
            if !is_markdown(path) {
                return WalkState::Continue;
            }
            if entry.metadata().map(|m| m.len() > MAX_FILE).unwrap_or(true) {
                return WalkState::Continue;
            }
            let Ok(content) = fs::read_to_string(path) else {
                return WalkState::Continue;
            };
            // Cheap early-out: skip files with no match before per-line work.
            if !re.is_match(&content) {
                return WalkState::Continue;
            }
            let rel = path
                .strip_prefix(root_p.as_path())
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();
            let path_s = path.to_string_lossy().into_owned();
            let mut local = Vec::new();
            for (i, line) in content.lines().enumerate() {
                if let Some(m) = re.find(line) {
                    // Byte offsets are only meaningful to JS if the prefix is
                    // ASCII; send char offsets instead.
                    let start = line[..m.start()].chars().count();
                    let end = start + line[m.start()..m.end()].chars().count();
                    local.push(SearchHit {
                        path: path_s.clone(),
                        rel: rel.clone(),
                        line: i + 1,
                        text: line.chars().take(400).collect(),
                        start,
                        end,
                    });
                }
            }
            if !local.is_empty() {
                count.fetch_add(local.len(), Ordering::Relaxed);
                hits.lock().unwrap().extend(local);
            }
            WalkState::Continue
        })
    });

    let mut out = Arc::try_unwrap(hits)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();
    // Parallel results arrive unordered — group by file, then line.
    out.sort_by(|a, b| a.rel.cmp(&b.rel).then(a.line.cmp(&b.line)));
    let truncated = out.len() > MAX_HITS;
    out.truncate(MAX_HITS);
    Ok(SearchResult {
        hits: out,
        truncated,
    })
}

// -------------------------------------------------------------- git status

#[derive(Serialize, PartialEq, Debug)]
struct GitEntry {
    /// Absolute path, so the frontend can match it against tree/tab paths.
    path: String,
    /// One of: modified · added · untracked · deleted · renamed · conflict
    status: &'static str,
}

#[derive(Serialize)]
struct GitInfo {
    /// Repository root — may sit above the open workspace.
    root: String,
    entries: Vec<GitEntry>,
    /// The status list hit its cap; marks are incomplete.
    truncated: bool,
}

/// Cap on reported entries. A repo with more pending changes than this is not
/// something a per-file badge can usefully convey anyway.
const MAX_GIT_ENTRIES: usize = 5_000;

/// True for the few `.git` paths worth reacting to: a commit, a stage, a
/// checkout. Filters out git's constant lock/temp churn.
fn is_git_signal(root: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy());
    if parts.next().as_deref() != Some(".git") {
        return false;
    }
    matches!(
        parts.next().as_deref(),
        Some("HEAD" | "index" | "ORIG_HEAD" | "MERGE_HEAD" | "refs")
    )
}

/// Collapse git's two-character porcelain code into one label. Index and
/// worktree columns are merged, most-alarming wins.
fn classify_status(x: char, y: char) -> &'static str {
    match (x, y) {
        ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D') => "conflict",
        ('?', '?') => "untracked",
        ('A', _) => "added",
        ('D', _) | (_, 'D') => "deleted",
        ('R', _) | ('C', _) => "renamed",
        _ => "modified",
    }
}

/// Parse `git status --porcelain -z` output into absolute-path entries.
///
/// Porcelain paths are relative to the repository root, but they are rebuilt
/// onto `workspace` (the folder the UI actually opened) by stripping `prefix`
/// — the workspace's path within the repo. That matters because
/// `--show-toplevel` resolves symlinks: a workspace opened via a symlinked
/// path would otherwise yield `/private/var/...` entries that match nothing in
/// the tree, and every badge would silently vanish.
fn parse_porcelain(
    workspace: &str,
    repo_root: &str,
    prefix: &str,
    raw: &str,
) -> (Vec<GitEntry>, bool) {
    let mut out = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(rec) = fields.next() {
        // "XY <path>" — anything shorter is the trailing empty field.
        if rec.len() < 4 {
            continue;
        }
        let mut chars = rec.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let rel = &rec[3..];
        // Rename/copy records are followed by a second field: the old path.
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            let _ = fields.next();
        }
        if out.len() >= MAX_GIT_ENTRIES {
            return (out, true);
        }
        let path = if prefix.is_empty() {
            Path::new(workspace).join(rel)
        } else if let Some(sub) = rel.strip_prefix(prefix) {
            Path::new(workspace).join(sub)
        } else {
            // Outside the opened folder — keep it addressable rather than
            // dropping it, even though no row will match.
            Path::new(repo_root).join(rel)
        };
        out.push(GitEntry {
            path: path.to_string_lossy().into_owned(),
            status: classify_status(x, y),
        });
    }
    (out, false)
}

fn git_output(dir: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

/// Pending git changes under `root`, or None when it isn't a repository (or git
/// isn't installed). Shells out to git rather than linking libgit2 — this runs
/// on a change event, not in a hot loop.
#[tauri::command]
async fn git_status(root: String) -> Option<GitInfo> {
    let repo = git_output(&root, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    if repo.is_empty() {
        return None;
    }
    // Where the opened folder sits inside the repo ("" when it *is* the root).
    let prefix = git_output(&root, &["rev-parse", "--show-prefix"])?
        .trim()
        .to_string();
    // `-- .` limits the walk to the open workspace; porcelain paths stay
    // relative to the repository root regardless.
    let raw = git_output(
        &root,
        &[
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ],
    )?;
    let (entries, truncated) = parse_porcelain(&root, &repo, &prefix, &raw);
    Some(GitInfo {
        root: repo,
        entries,
        truncated,
    })
}

// ---------------------------------------------------------- file watching

#[derive(Serialize, Clone)]
struct FsChange {
    /// Directories whose listing may have changed.
    dirs: Vec<String>,
    /// Individual paths touched (created/modified/removed/renamed).
    paths: Vec<String>,
    /// Too many events to enumerate — the UI should refresh wholesale.
    bulk: bool,
    /// Something in `.git` moved (commit, stage, checkout) — re-read git status
    /// even though no visible file changed.
    git: bool,
}

/// Watch `path` recursively and emit debounced `fs-change` events so the tree
/// and the open document stay in step with edits made outside the app.
#[tauri::command]
fn watch_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<FsWatcher>();
    // Drop the previous watcher first; that closes its channel and ends the
    // debounce thread below.
    *state.0.lock().unwrap() = None;

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&path), notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(watcher);

    let handle = app.clone();
    let root = PathBuf::from(&path);
    std::thread::spawn(move || {
        const MAX_REPORTED: usize = 200;
        let collect = |set: &mut BTreeSet<PathBuf>,
                       git: &mut bool,
                       res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            for p in ev.paths {
                // Git's own bookkeeping is invisible in the tree but changes
                // every file's status, so it's a refresh signal, not content.
                if is_git_signal(&root, &p) {
                    *git = true;
                    continue;
                }
                // Our own atomic-save temp files and anything hidden/junk are
                // noise, not user-visible changes.
                if in_skipped_dir(&root, &p) {
                    continue;
                }
                if p
                    .file_name()
                    .map(|n| {
                        let n = n.to_string_lossy();
                        n.starts_with('.') || n.ends_with(".mad-tmp")
                    })
                    .unwrap_or(true)
                {
                    continue;
                }
                set.insert(p);
            }
        };

        loop {
            // Block until something happens (or the watcher is dropped).
            let Ok(first) = rx.recv() else { return };
            let mut paths = BTreeSet::new();
            let mut git = false;
            collect(&mut paths, &mut git, first);
            // Coalesce the burst: editors and syncs write in several syscalls.
            let deadline = Instant::now() + Duration::from_millis(600);
            loop {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                match rx.recv_timeout(remaining.min(Duration::from_millis(160))) {
                    Ok(ev) => collect(&mut paths, &mut git, ev),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break, // quiet
                    Err(_) => return,                                         // watcher dropped
                }
            }
            if paths.is_empty() && !git {
                continue;
            }
            let bulk = paths.len() > MAX_REPORTED;
            let dirs: Vec<String> = paths
                .iter()
                .filter_map(|p| p.parent())
                .map(|d| d.to_string_lossy().into_owned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .take(MAX_REPORTED)
                .collect();
            let payload = FsChange {
                dirs,
                paths: paths
                    .iter()
                    .take(MAX_REPORTED)
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
                bulk,
                git,
            };
            if handle.emit("fs-change", payload).is_err() {
                return;
            }
        }
    });
    Ok(())
}

// -------------------------------------------------------------- quit flow

/// Set true by the frontend to abort a pending ⌘Q (e.g. the user chose to keep
/// an unsaved draft), so the exit backstop thread does not force-quit.
struct ExitAborted(Arc<AtomicBool>);

/// Called by the frontend once pending edits are flushed; exits for real.
#[tauri::command]
fn confirm_exit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Cancel a pending ⌘Q — the user declined to quit (unsaved draft kept).
#[tauri::command]
fn cancel_exit(state: tauri::State<ExitAborted>) {
    state.0.store(true, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Recents(Mutex::new(load_recents(&handle))));
            app.manage(MenuState {
                save: Mutex::new(None),
                save_as: Mutex::new(None),
                enabled: Mutex::new((false, false)),
            });
            app.manage(FsWatcher(Mutex::new(None)));
            app.manage(ExitAborted(Arc::new(AtomicBool::new(false))));
            rebuild_menu(&handle)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            // Menu items that are just a named signal to the frontend.
            const FORWARD: [(&str, &str); 17] = [
                ("open_folder", "menu-open-folder"),
                ("new_file", "menu-new-file"),
                ("new_folder", "menu-new-folder"),
                ("save", "menu-save"),
                ("save_as", "menu-save-as"),
                ("export_html", "menu-export-html"),
                ("close_tab", "menu-close-tab"),
                ("find", "menu-find"),
                ("find_replace", "menu-find-replace"),
                ("search_files", "menu-search-files"),
                ("toggle_spellcheck", "menu-toggle-spellcheck"),
                ("quick_open", "menu-quick-open"),
                ("command_palette", "menu-command-palette"),
                ("toggle_source", "menu-toggle-source"),
                ("toggle_split", "menu-toggle-split"),
                ("toggle_sidebar", "menu-toggle-sidebar"),
                ("toggle_theme", "menu-toggle-theme"),
            ];
            if let Some((_, ev)) = FORWARD.iter().find(|(k, _)| *k == id) {
                let _ = app.emit(ev, ());
                return;
            }
            match id {
                "zoom_in" => {
                    let _ = app.emit("menu-zoom", 1i32);
                }
                "zoom_out" => {
                    let _ = app.emit("menu-zoom", -1i32);
                }
                "zoom_reset" => {
                    let _ = app.emit("menu-zoom", 0i32);
                }
                "clear_recents" => {
                    if let Some(state) = app.try_state::<Recents>() {
                        state.0.lock().unwrap().clear();
                    }
                    save_recents(app, &[]);
                    let _ = rebuild_menu(app);
                }
                other => {
                    if let Some(path) = other.strip_prefix("recent::") {
                        let _ = app.emit("menu-open-recent", path.to_string());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            list_dir,
            read_file,
            file_stamp,
            write_file,
            create_file,
            read_image,
            save_image,
            push_recent,
            set_menu_state,
            save_dialog,
            export_dialog,
            confirm,
            confirm_choice,
            message,
            rename_path,
            move_into,
            create_folder,
            duplicate_path,
            trash_path,
            reveal_path,
            open_path,
            list_all,
            search_files,
            git_status,
            watch_folder,
            confirm_exit,
            cancel_exit
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // User-initiated quit (⌘Q): hold the exit once so the frontend can
            // flush edits and warn about an unsaved draft. It then calls either
            // confirm_exit (proceed) or cancel_exit (abort — keep the draft).
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                    let aborted = app.state::<ExitAborted>().0.clone();
                    aborted.store(false, Ordering::SeqCst);
                    let _ = app.emit("flush-and-exit", ());
                    // Backstop: force-quit only if the webview never answers —
                    // long enough for the user to respond to a save prompt, and
                    // skipped entirely if they chose to stay.
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(20));
                        if !aborted.load(Ordering::SeqCst) {
                            handle.exit(0);
                        }
                    });
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::atomic::AtomicU32;
    use std::task::{Context, Poll, Wake, Waker};

    struct Noop;
    impl Wake for Noop {
        fn wake(self: Arc<Self>) {}
    }

    /// The filesystem commands are `async` only so Tauri runs them off the UI
    /// thread — they never actually yield, so one poll completes them.
    fn run<F: Future>(fut: F) -> F::Output {
        let waker = Waker::from(Arc::new(Noop));
        let mut cx = Context::from_waker(&waker);
        let mut fut = Box::pin(fut);
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => v,
            Poll::Pending => panic!("command awaited unexpectedly"),
        }
    }

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh empty directory, removed when the guard drops.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let p = std::env::temp_dir().join(format!("mad-test-{}-{n}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn s(&self, rel: &str) -> String {
            self.0.join(rel).to_string_lossy().into_owned()
        }
        fn write(&self, rel: &str, body: &str) -> String {
            let p = self.0.join(rel);
            if let Some(d) = p.parent() {
                fs::create_dir_all(d).unwrap();
            }
            fs::write(&p, body).unwrap();
            p.to_string_lossy().into_owned()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    // ------------------------------------------------------------- writing

    #[test]
    fn write_is_atomic_and_leaves_no_temp_files() {
        let t = TempDir::new();
        let path = t.s("note.md");
        let stamp = run(write_file(path.clone(), "hello".into(), None)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
        assert_eq!(names(t.path()), vec!["note.md"]);
        assert!(!stamp.is_empty());
    }

    #[test]
    fn write_refuses_when_the_file_changed_underneath() {
        let t = TempDir::new();
        let path = t.write("note.md", "original");
        let stamp = stamp_of(Path::new(&path));

        // Someone else edits the file. Sleep so mtime definitely differs even
        // on filesystems with coarse timestamps.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&path, "theirs, but longer").unwrap();

        let err = run(write_file(path.clone(), "mine".into(), Some(stamp))).unwrap_err();
        assert_eq!(err, CONFLICT);
        assert_eq!(fs::read_to_string(&path).unwrap(), "theirs, but longer");

        // Forcing (no expectation) still wins — that's the "Keep Mine" path.
        run(write_file(path.clone(), "mine".into(), None)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
    }

    #[test]
    fn write_accepts_a_matching_stamp_and_returns_the_new_one() {
        let t = TempDir::new();
        let path = t.write("note.md", "a");
        let stamp = stamp_of(Path::new(&path));
        let next = run(write_file(path.clone(), "bb".into(), Some(stamp.clone()))).unwrap();
        assert_ne!(next, stamp);
        assert_eq!(next, stamp_of(Path::new(&path)));
    }

    #[cfg(unix)]
    #[test]
    fn write_preserves_file_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let t = TempDir::new();
        let path = t.write("note.md", "a");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        run(write_file(path.clone(), "b".into(), None)).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // ------------------------------------------------------------- naming

    #[test]
    fn new_files_never_clobber_an_existing_one() {
        let t = TempDir::new();
        let dir = t.path().to_string_lossy().into_owned();
        let a = run(create_file(dir.clone(), "Untitled.md".into())).unwrap();
        let b = run(create_file(dir.clone(), "Untitled.md".into())).unwrap();
        assert!(a.ends_with("Untitled.md"));
        assert!(b.ends_with("Untitled 2.md"));
        assert_ne!(a, b);
    }

    #[test]
    fn image_names_cannot_escape_their_directory() {
        assert_eq!(safe_file_name("../../etc/passwd", "x.png"), "passwd");
        assert_eq!(safe_file_name("a/b/c.png", "x.png"), "c.png");
        assert_eq!(safe_file_name("   ", "x.png"), "x.png");
        assert_eq!(safe_file_name("..", "x.png"), "x.png");
        assert_eq!(safe_file_name(".hidden.png", "x.png"), "hidden.png");
        assert_eq!(safe_file_name("ok name.png", "x.png"), "ok name.png");
    }

    #[test]
    fn rename_refuses_to_overwrite_but_allows_case_changes() {
        let t = TempDir::new();
        let a = t.write("a.md", "a");
        let b = t.write("b.md", "b");
        assert!(run(rename_path(a.clone(), b.clone())).is_err());
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");

        let upper = t.s("A.md");
        run(rename_path(a, upper.clone())).unwrap();
        assert_eq!(fs::read_to_string(&upper).unwrap(), "a");
    }

    #[test]
    fn move_refuses_itself_and_existing_targets() {
        let t = TempDir::new();
        fs::create_dir(t.path().join("outer")).unwrap();
        fs::create_dir(t.path().join("outer/inner")).unwrap();
        t.write("outer/note.md", "n");
        t.write("dest/note.md", "other");

        assert!(run(move_into(t.s("outer"), t.s("outer/inner"))).is_err());
        assert!(run(move_into(t.s("outer/note.md"), t.s("dest"))).is_err());
        assert_eq!(fs::read_to_string(t.s("dest/note.md")).unwrap(), "other");

        fs::create_dir(t.path().join("empty")).unwrap();
        let moved = run(move_into(t.s("outer/note.md"), t.s("empty"))).unwrap();
        assert_eq!(fs::read_to_string(&moved).unwrap(), "n");
    }

    #[test]
    fn duplicate_copies_files_and_whole_folders() {
        let t = TempDir::new();
        let f = t.write("note.md", "body");
        let copy = run(duplicate_path(f)).unwrap();
        assert!(copy.ends_with("note copy.md"));
        assert_eq!(fs::read_to_string(&copy).unwrap(), "body");

        t.write("dir/deep/x.md", "deep");
        let dcopy = run(duplicate_path(t.s("dir"))).unwrap();
        assert_eq!(fs::read_to_string(format!("{dcopy}/deep/x.md")).unwrap(), "deep");
    }

    // ------------------------------------------------------------ listing

    #[test]
    fn listing_hides_dotfiles_junk_dirs_and_other_file_types() {
        let t = TempDir::new();
        t.write("note.md", "");
        t.write("pic.PNG", "");
        t.write("script.rs", "");
        t.write(".secret.md", "");
        fs::create_dir(t.path().join("notes")).unwrap();
        fs::create_dir(t.path().join("node_modules")).unwrap();

        let listed: Vec<String> = run(list_dir(t.s("")))
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        // Directories first, then files, each case-insensitively sorted.
        assert_eq!(listed, vec!["notes", "note.md", "pic.PNG"]);
    }

    #[test]
    fn quick_open_index_skips_junk_directories() {
        let t = TempDir::new();
        t.write("a.md", "");
        t.write("sub/b.md", "");
        t.write("node_modules/pkg/readme.md", "");
        t.write(".git/config.md", "");

        let mut rels: Vec<String> = run(list_all(t.s("")))
            .unwrap()
            .into_iter()
            .map(|f| f.rel)
            .collect();
        rels.sort();
        assert_eq!(rels, vec!["a.md", "sub/b.md"]);
    }

    // ----------------------------------------------------------- searching

    fn search(t: &TempDir, q: &str, regex: bool, case: bool, word: bool) -> Vec<SearchHit> {
        run(search_files(t.s(""), q.into(), regex, case, word))
            .unwrap()
            .hits
    }

    #[test]
    fn search_reports_character_offsets_not_byte_offsets() {
        let t = TempDir::new();
        // Four multi-byte chars before the match: byte offset would be 8+.
        t.write("a.md", "café ☕ needle here\n");
        let hits = search(&t, "needle", false, false, false);
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        let chars: Vec<char> = h.text.chars().collect();
        assert_eq!(
            chars[h.start..h.end].iter().collect::<String>(),
            "needle",
            "offsets must index the string as characters"
        );
    }

    #[test]
    fn search_honours_case_and_whole_word() {
        let t = TempDir::new();
        t.write("a.md", "Cat cathode cat\n");
        assert_eq!(search(&t, "cat", false, false, false).len(), 1); // one per line
        assert!(!search(&t, "CAT", false, false, false).is_empty());
        assert!(search(&t, "CAT", false, true, false).is_empty());

        t.write("b.md", "cathode only\n");
        assert!(search(&t, "cat", false, true, true)
            .iter()
            .all(|h| h.rel != "b.md"));
    }

    #[test]
    fn search_only_reads_markdown_and_skips_junk() {
        let t = TempDir::new();
        t.write("a.md", "needle\n");
        t.write("b.txt", "needle\n");
        t.write("node_modules/c.md", "needle\n");
        let rels: Vec<String> = search(&t, "needle", false, false, false)
            .into_iter()
            .map(|h| h.rel)
            .collect();
        assert_eq!(rels, vec!["a.md"]);
    }

    #[test]
    fn a_bad_regex_is_an_error_not_a_panic() {
        let t = TempDir::new();
        assert!(run(search_files(t.s(""), "([".into(), true, false, false)).is_err());
    }

    // ------------------------------------------------------------ watching

    #[test]
    fn skipped_dirs_cover_hidden_and_build_output() {
        let root = Path::new("/work");
        assert!(in_skipped_dir(root, Path::new("/work/node_modules/b.md")));
        assert!(in_skipped_dir(root, Path::new("/work/.git/b.md")));
        assert!(in_skipped_dir(root, Path::new("/work/notes/.draft.md")));
        assert!(!in_skipped_dir(root, Path::new("/work/notes/b.md")));
    }

    // ----------------------------------------------------------- git status

    #[test]
    fn porcelain_parsing_covers_every_status_shape() {
        // Real `-z` output: NUL-separated, renames carry a second field.
        let raw = concat!(
            " M src/a.md\0",
            "M  src/b.md\0",
            "?? new.md\0",
            "A  added.md\0",
            " D gone.md\0",
            "R  now.md\0was.md\0",
            "UU both.md\0",
            "AM staged-then-edited.md\0",
        );
        let (entries, truncated) = parse_porcelain("/repo", "/repo", "", raw);
        assert!(!truncated);
        let got: Vec<(&str, &str)> = entries
            .iter()
            .map(|e| (e.path.as_str(), e.status))
            .collect();
        assert_eq!(
            got,
            vec![
                ("/repo/src/a.md", "modified"),
                ("/repo/src/b.md", "modified"),
                ("/repo/new.md", "untracked"),
                ("/repo/added.md", "added"),
                ("/repo/gone.md", "deleted"),
                ("/repo/now.md", "renamed"),
                ("/repo/both.md", "conflict"),
                ("/repo/staged-then-edited.md", "added"),
            ],
            "a rename's old-path field must not be parsed as another entry"
        );
    }

    #[test]
    fn porcelain_parsing_handles_spaces_and_unicode_in_names() {
        let raw = " M docs/my café notes.md\0?? a b c.md\0";
        let (entries, _) = parse_porcelain("/repo", "/repo", "", raw);
        assert_eq!(entries[0].path, "/repo/docs/my café notes.md");
        assert_eq!(entries[1].path, "/repo/a b c.md");
    }

    #[test]
    fn porcelain_paths_are_rebuilt_onto_the_opened_folder() {
        // The workspace is `docs/` inside a repo whose canonical root differs
        // from the path the user opened (the classic macOS /var → /private/var
        // symlink). Entries must come back under the opened path.
        let raw = " M docs/a.md\0?? docs/sub/b.md\0 M elsewhere/c.md\0";
        let (entries, _) =
            parse_porcelain("/var/work/docs", "/private/var/work", "docs/", raw);
        let got: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            got,
            vec![
                "/var/work/docs/a.md",
                "/var/work/docs/sub/b.md",
                // Outside the opened folder: kept, but anchored to the repo.
                "/private/var/work/elsewhere/c.md",
            ]
        );
    }

    #[test]
    fn only_meaningful_git_paths_trigger_a_status_refresh() {
        let root = Path::new("/work");
        assert!(is_git_signal(root, Path::new("/work/.git/HEAD")));
        assert!(is_git_signal(root, Path::new("/work/.git/index")));
        assert!(is_git_signal(root, Path::new("/work/.git/refs/heads/main")));
        // Lock and object churn would fire constantly for no visible change.
        assert!(!is_git_signal(root, Path::new("/work/.git/index.lock")));
        assert!(!is_git_signal(root, Path::new("/work/.git/objects/ab/cdef")));
        assert!(!is_git_signal(root, Path::new("/work/notes/.git-notes.md")));
        assert!(!is_git_signal(root, Path::new("/work/note.md")));
    }

    #[test]
    fn git_status_is_none_outside_a_repository() {
        let t = TempDir::new();
        // A bare temp dir under /tmp is not inside any repo checkout.
        assert!(run(git_status(t.s(""))).is_none());
    }

    /// End-to-end against a real repository: exercises the `git` invocation,
    /// porcelain parsing and absolute-path joining together.
    #[test]
    fn git_status_reads_a_real_repository() {
        let t = TempDir::new();
        let dir = t.s("");
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .current_dir(&dir)
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "t"]);
        t.write("tracked.md", "one\n");
        t.write("nested/deep.md", "deep\n");
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "init"]);

        // Now make one of each interesting state.
        t.write("tracked.md", "one\ntwo\n"); // modified in the worktree
        t.write("fresh.md", "new\n"); // untracked
        t.write("staged.md", "s\n");
        git(&["add", "staged.md"]); // added to the index
        fs::remove_file(t.path().join("nested/deep.md")).unwrap(); // deleted

        let info = run(git_status(dir.clone())).expect("should be a repository");
        let by_path: std::collections::HashMap<&str, &str> = info
            .entries
            .iter()
            .map(|e| (e.path.as_str(), e.status))
            .collect();

        // Paths come back absolute so the UI can match them against the tree.
        let abs = |rel: &str| t.s(rel);
        assert_eq!(by_path.get(abs("tracked.md").as_str()), Some(&"modified"));
        assert_eq!(by_path.get(abs("fresh.md").as_str()), Some(&"untracked"));
        assert_eq!(by_path.get(abs("staged.md").as_str()), Some(&"added"));
        assert_eq!(by_path.get(abs("nested/deep.md").as_str()), Some(&"deleted"));
        assert!(!info.truncated);
        // Committed-and-untouched files must not be reported at all.
        assert!(!info.entries.iter().any(|e| e.path.ends_with("nested/other.md")));

        // The repo root is discovered even when the workspace is a subfolder.
        let sub = run(git_status(t.s("nested"))).expect("subdir is still in the repo");
        assert_eq!(
            fs::canonicalize(&sub.root).unwrap(),
            fs::canonicalize(t.path()).unwrap()
        );
    }

    #[test]
    fn a_workspace_inside_a_dotted_folder_still_reports_changes() {
        // Everything under ~/.notes would be "hidden" if we judged the whole
        // absolute path instead of the part below the workspace root.
        let root = Path::new("/Users/x/.notes");
        assert!(!in_skipped_dir(root, Path::new("/Users/x/.notes/today.md")));
        assert!(!in_skipped_dir(root, Path::new("/Users/x/.notes/sub/today.md")));
        assert!(in_skipped_dir(root, Path::new("/Users/x/.notes/.git/HEAD")));
    }
}
