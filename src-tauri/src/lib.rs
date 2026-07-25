use base64::Engine;
use notify::Watcher as _;
use serde::Serialize;
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
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
#[derive(Serialize, Debug)]
struct FileData {
    content: String,
    stamp: String,
}

/// Recently opened folders, most-recent first. Persisted to the app config dir
/// so the native File ▸ Open Recent submenu survives restarts.
struct Recents(Mutex<Vec<String>>);

/// Which app state a gated menu item needs before it is enabled. An item
/// that is live with nothing to act on is a silent no-op — worse than grey.
#[derive(Clone, Copy)]
enum Gate {
    /// An active markdown document (file or draft).
    Doc,
    /// Any open tab.
    Tab,
    /// An open workspace folder.
    Folder,
}

fn gate_on(gate: Gate, doc: bool, tab: bool, folder: bool) -> bool {
    match gate {
        Gate::Doc => doc,
        Gate::Tab => tab,
        Gate::Folder => folder,
    }
}

/// Handles to the state-gated menu items so the frontend can enable/disable
/// them as the app state changes. `enabled` remembers the latest state across
/// menu rebuilds (e.g. when Open Recent changes).
struct MenuState {
    gated: Mutex<Vec<(MenuItem<Wry>, Gate)>>,
    enabled: Mutex<(bool, bool, bool)>,
}

/// Label each recent by folder name, disambiguating duplicates with their
/// parent directory — two workspaces named "docs" must not render as two
/// identical rows.
fn recent_labels(paths: &[String]) -> Vec<String> {
    let base = |p: &str| {
        p.rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or(p)
            .to_string()
    };
    let mut counts = std::collections::HashMap::new();
    for p in paths {
        *counts.entry(base(p)).or_insert(0u32) += 1;
    }
    paths
        .iter()
        .map(|p| {
            let b = base(p);
            if counts[&b] > 1 {
                if let Some(parent) = Path::new(p)
                    .parent()
                    .and_then(|d| d.file_name())
                    .map(|n| n.to_string_lossy().into_owned())
                {
                    return format!("{b} — {parent}");
                }
            }
            b
        })
        .collect()
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
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .any(|c| {
            let s = c.as_os_str().to_string_lossy();
            is_junk_dir(&s) || (s.starts_with('.') && s.len() > 1)
        })
}

// ------------------------------------------------------------------ scope

/// Paths the frontend is allowed to touch. Roots come from the native folder
/// dialog (or the recents file, whose entries were all dialog-granted once);
/// individual files come from the save/export dialogs. The webview can never
/// mint a grant itself — this is defense-in-depth so a compromised renderer
/// can't leave the workspace.
#[derive(Default)]
struct Scope {
    roots: Mutex<Vec<PathBuf>>,
    files: Mutex<HashSet<PathBuf>>,
}

/// Process-global rather than Tauri-managed state, deliberately: `State` has
/// no public constructor, so managed state would force every test through a
/// mock app — this way the existing tests call commands directly and still
/// exercise the real checks (TempDir grants itself on creation).
fn scope() -> &'static Scope {
    static S: OnceLock<Scope> = OnceLock::new();
    S.get_or_init(Scope::default)
}

fn deny(raw: &str) -> String {
    let name = Path::new(raw)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw.to_string());
    format!("“{name}” is outside the open workspace")
}

/// Canonicalize for a membership check. A not-yet-existing file resolves
/// through its parent; `..` is rejected outright so a traversal can't ride in
/// on a non-existent suffix. Symlinks resolve, so a link pointing out of the
/// workspace lands outside and fails the membership test.
fn canonical_target(raw: &str) -> Result<PathBuf, String> {
    let p = Path::new(raw);
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(deny(raw));
    }
    if let Ok(c) = fs::canonicalize(p) {
        return Ok(c);
    }
    let parent = p.parent().ok_or_else(|| deny(raw))?;
    let name = p.file_name().ok_or_else(|| deny(raw))?;
    let base = fs::canonicalize(parent).map_err(|_| deny(raw))?;
    Ok(base.join(name))
}

impl Scope {
    fn grant_root(&self, raw: &str) {
        if let Ok(c) = canonical_target(raw) {
            let mut roots = self.roots.lock().unwrap_or_else(|e| e.into_inner());
            if !roots.contains(&c) {
                roots.push(c);
            }
        }
    }

    fn grant_file(&self, raw: &str) {
        if let Ok(c) = canonical_target(raw) {
            self.files
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(c);
        }
    }

    /// Under a granted workspace root.
    fn check_root(&self, raw: &str) -> Result<(), String> {
        let c = canonical_target(raw)?;
        let roots = self.roots.lock().unwrap_or_else(|e| e.into_inner());
        // starts_with is component-wise: /ws2 is not under /ws.
        if roots.iter().any(|r| c.starts_with(r)) {
            Ok(())
        } else {
            Err(deny(raw))
        }
    }

    /// Under a granted root, or exactly a dialog-granted file.
    fn check(&self, raw: &str) -> Result<(), String> {
        if self.check_root(raw).is_ok() {
            return Ok(());
        }
        let c = canonical_target(raw)?;
        if self
            .files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&c)
        {
            Ok(())
        } else {
            Err(deny(raw))
        }
    }
}

// ---------------------------------------------------------------- recents

fn recents_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("recents.json"))
}

/// Read the recents list from `file`, dropping anything that no longer exists.
/// Split from the AppHandle lookup so it can be tested directly.
fn read_recents(file: &Path) -> Vec<String> {
    fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        // Drop folders that have since been deleted, renamed or unmounted.
        .filter(|p| Path::new(p).is_dir())
        .collect()
}

fn write_recents(file: &Path, recents: &[String]) {
    if let Ok(s) = serde_json::to_string(recents) {
        let _ = fs::write(file, s);
    }
}

/// Add `path` to the front, most-recent first, deduped and capped.
fn push_recent_list(recents: &mut Vec<String>, path: String) {
    recents.retain(|p| p != &path);
    recents.insert(0, path);
    recents.truncate(MAX_RECENTS);
}

fn load_recents(app: &tauri::AppHandle) -> Vec<String> {
    recents_file(app)
        .map(|p| read_recents(&p))
        .unwrap_or_default()
}

fn save_recents(app: &tauri::AppHandle, recents: &[String]) {
    if let Some(p) = recents_file(app) {
        write_recents(&p, recents);
    }
}

// ------------------------------------------------------------------- menu

/// Build (or rebuild) the whole application menu — reading the current recents
/// and Save enable-state from managed state — and install it.
fn rebuild_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let recents = app
        .state::<Recents>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let (doc, tab, folder) = *app
        .state::<MenuState>()
        .enabled
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let item = |id: &str, label: &str, accel: Option<&str>| -> tauri::Result<MenuItem<Wry>> {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    // A gated item is built in the right state and remembered, so
    // set_menu_state can flip it live as the app state changes.
    let mut gated: Vec<(MenuItem<Wry>, Gate)> = Vec::new();
    let mut gitem =
        |id: &str, label: &str, accel: Option<&str>, gate: Gate| -> tauri::Result<MenuItem<Wry>> {
            let mut b =
                MenuItemBuilder::with_id(id, label).enabled(gate_on(gate, doc, tab, folder));
            if let Some(a) = accel {
                b = b.accelerator(a);
            }
            let it = b.build(app)?;
            gated.push((it.clone(), gate));
            Ok(it)
        };

    // The About panel shows a generic document icon unless it is handed one
    // explicitly — reuse the window icon, which Tauri already embedded from the
    // bundle at build time.
    // Not `default_window_icon()`: that returns the first entry in the bundle
    // icon list, which is 32x32, and the About panel renders far larger than
    // that — it looked soft. Load a proper resolution instead.
    let about_icon =
        tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")).ok();
    let about = AboutMetadataBuilder::new()
        .name(Some("mad"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .icon(about_icon)
        .license(Some("MIT"))
        .website(Some("https://github.com/digitaljohn/mad"))
        .website_label(Some("mad on GitHub"))
        .comments(Some(
            "A clean markdown editor for folders full of specs, notes and documentation.",
        ))
        .build();

    // App menu (macOS conventions): about, services, hide, quit.
    let app_menu = SubmenuBuilder::new(app, "mad")
        .about(Some(about))
        .item(&item("check_updates", "Check for Updates…", None)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let save = gitem("save", "Save", Some("CmdOrCtrl+S"), Gate::Doc)?;
    let save_as = gitem("save_as", "Save As…", Some("CmdOrCtrl+Shift+S"), Gate::Doc)?;
    let new_file = item("new_file", "New File", Some("CmdOrCtrl+N"))?;
    let new_folder = gitem(
        "new_folder",
        "New Folder",
        Some("CmdOrCtrl+Shift+N"),
        Gate::Folder,
    )?;
    let open_folder = item("open_folder", "Open Folder…", Some("CmdOrCtrl+O"))?;
    let close_tab = gitem("close_tab", "Close Tab", Some("CmdOrCtrl+W"), Gate::Tab)?;
    let export_html = gitem("export_html", "Export as HTML…", None, Gate::Doc)?;

    let mut recent = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        recent = recent.item(
            &MenuItemBuilder::with_id("recent_none", "No Recent Folders")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for (path, label) in recents.iter().zip(recent_labels(&recents)) {
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
        .item(&gitem("find", "Find…", Some("CmdOrCtrl+F"), Gate::Doc)?)
        .item(&gitem(
            "find_replace",
            "Find & Replace…",
            Some("CmdOrCtrl+Alt+F"),
            Gate::Doc,
        )?)
        .item(&gitem(
            "search_files",
            "Find in Files…",
            Some("CmdOrCtrl+Shift+F"),
            Gate::Folder,
        )?)
        .separator()
        .item(&item(
            "toggle_spellcheck",
            "Check Spelling While Typing",
            None,
        )?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&gitem(
            "quick_open",
            "Quick Open…",
            Some("CmdOrCtrl+P"),
            Gate::Folder,
        )?)
        .item(&item(
            "command_palette",
            "Command Palette…",
            Some("CmdOrCtrl+Shift+P"),
        )?)
        .separator()
        .item(&gitem(
            "goto_heading",
            "Go to Heading…",
            Some("CmdOrCtrl+Shift+O"),
            Gate::Doc,
        )?)
        .separator()
        .item(&gitem(
            "toggle_source",
            "Toggle Markdown Source",
            Some("CmdOrCtrl+Shift+M"),
            Gate::Doc,
        )?)
        .item(&gitem(
            "toggle_split",
            "Toggle Split Preview",
            Some("CmdOrCtrl+Shift+V"),
            Gate::Doc,
        )?)
        .item(&item(
            "toggle_sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+\\"),
        )?)
        .separator()
        .item(&gitem(
            "show_changes",
            "Show Changes",
            Some("CmdOrCtrl+Shift+D"),
            Gate::Doc,
        )?)
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
        .separator()
        // ⌘W belongs to Close Tab, so the window needs its own shortcut —
        // without this there is no keyboard way to close the window at all.
        .item(&item(
            "close_window",
            "Close Window",
            Some("CmdOrCtrl+Shift+W"),
        )?)
        .build()?;

    // A "Help" submenu also gets macOS's built-in menu search field for free.
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&item("help_github", "mad on GitHub", None)?)
        .item(&item("help_issue", "Report an Issue…", None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;

    // Remember the new item handles so set_menu_state can toggle them live.
    let ms = app.state::<MenuState>();
    *ms.gated.lock().unwrap_or_else(|e| e.into_inner()) = gated;
    Ok(())
}

/// Enable/disable the state-gated menu items: `doc` = an active markdown
/// document, `tab` = any open tab, `folder` = an open workspace. Async so the
/// call never runs on the UI thread; the menu mutation itself hops back to
/// the main thread, where macOS requires it.
#[tauri::command]
async fn set_menu_state(app: tauri::AppHandle, doc: bool, tab: bool, folder: bool) {
    {
        let ms = app.state::<MenuState>();
        *ms.enabled.lock().unwrap_or_else(|e| e.into_inner()) = (doc, tab, folder);
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let ms = handle.state::<MenuState>();
        for (item, gate) in ms.gated.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            let _ = item.set_enabled(gate_on(*gate, doc, tab, folder));
        }
    });
}

/// Record a folder as recently opened; persists and rebuilds the menu.
/// Async: the config-dir write and PNG-decoding menu rebuild happen on every
/// folder open, and neither belongs on the UI thread.
#[tauri::command]
async fn push_recent(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Only dialog-granted roots may enter the recents file — it seeds the
    // scope on next launch, so an unchecked entry would become a grant.
    scope().check_root(&path)?;
    let snapshot = {
        let state = app.state::<Recents>();
        let mut recents = state.0.lock().unwrap_or_else(|e| e.into_inner());
        push_recent_list(&mut recents, path);
        recents.clone()
    };
    save_recents(&app, &snapshot);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = rebuild_menu(&handle); // menus are main-thread-only on macOS
    });
    Ok(())
}

// ------------------------------------------------------------ file system

/// Open the native folder picker and return the chosen directory.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    let chosen = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned());
    if let Some(p) = &chosen {
        // The user picked it in a native dialog — that's what a grant is.
        scope().grant_root(p);
    }
    chosen
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
    scope().check_root(&path)?;
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
async fn file_stamp(path: String) -> Result<String, String> {
    scope().check(&path)?;
    Ok(stamp_of(Path::new(&path)))
}

/// Turn an io::Error into something a toast can show without a Debug dump.
fn friendly_io(e: std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => "The file no longer exists.".into(),
        PermissionDenied => "You don’t have permission to do that.".into(),
        StorageFull => "The disk is full.".into(),
        ReadOnlyFilesystem => "The volume is read-only.".into(),
        InvalidData => "This file isn’t UTF-8 text.".into(),
        _ => e.to_string(),
    }
}

/// Cap on documents read into the webview. Markdown this size is not a note;
/// slurping it into a JSON IPC payload would wedge the renderer.
const MAX_DOC: u64 = 32 * 1024 * 1024;

#[tauri::command]
async fn read_file(path: String) -> Result<FileData, String> {
    scope().check(&path)?;
    let p = Path::new(&path);
    if fs::metadata(p).map(|m| m.len() > MAX_DOC).unwrap_or(false) {
        return Err("This file is too large to open (over 32 MB).".into());
    }
    let content = fs::read_to_string(p).map_err(friendly_io)?;
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
    scope().check(&path)?;
    // Resolve symlinks up front: renaming over a link would replace the link
    // itself with a regular file, orphaning the real document it points at.
    let resolved = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let target = resolved.as_path();
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
    // Hidden temp name in the same directory (same volume ⇒ rename is atomic),
    // made unique per write: two overlapping saves must never share one temp,
    // or one could rename the other's half-written bytes over the real file.
    static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{name}.{}-{}.mad-tmp",
        std::process::id(),
        WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    let write = |tmp: &Path| -> std::io::Result<()> {
        let mut f = fs::File::create(tmp)?;
        // Match the original's permissions before any content goes in, so a
        // private file is never briefly readable through a default-mode temp.
        if let Ok(meta) = fs::metadata(target) {
            let _ = fs::set_permissions(tmp, meta.permissions());
        }
        f.write_all(content.as_bytes())?;
        f.sync_all()
    };
    if let Err(e) = write(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(friendly_io(e));
    }
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(friendly_io(e));
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
    scope().check_root(&dir)?;
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
    scope().check(&path)?;
    const MAX_IMAGE: u64 = 64 * 1024 * 1024;
    let meta = fs::metadata(&path).map_err(friendly_io)?;
    if meta.len() > MAX_IMAGE {
        return Err("Image is too large to preview".into());
    }
    let bytes = fs::read(&path).map_err(friendly_io)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Save an uploaded image (base64) next to the markdown file.
/// Returns the file name to reference relatively from the document.
#[tauri::command]
async fn save_image(dir: String, name: String, data: String) -> Result<String, String> {
    scope().check_root(&dir)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    let safe = safe_file_name(&name, "image.png");
    let (stem, ext) = split_name(&safe);
    // create_new, like create_file: a name freed up between the uniqueness
    // probe and the write must not let this clobber whatever claimed it.
    for n in 1..1000u32 {
        let candidate = if n == 1 {
            Path::new(&dir).join(&safe)
        } else {
            Path::new(&dir).join(format!("{stem} {n}{ext}"))
        };
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut f) => {
                f.write_all(&bytes).map_err(friendly_io)?;
                return Ok(candidate
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(safe));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(friendly_io(e)),
        }
    }
    Err("Too many images with that name".into())
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
    let chosen = builder
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
        });
    if let Some(p) = &chosen {
        // Chosen in a native dialog — Save As may legitimately leave the
        // workspace, and the file stays writable for the rest of the session.
        scope().grant_file(p);
    }
    chosen
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
    let chosen = builder
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| {
            // Same append-only rule as save_dialog: a name typed without the
            // extension still exports as e.g. `.html`, never rewritten.
            let has = p
                .extension()
                .map(|e| e.to_string_lossy().eq_ignore_ascii_case(&ext))
                .unwrap_or(false);
            if has {
                p.to_string_lossy().into_owned()
            } else {
                let mut s = p.into_os_string();
                s.push(format!(".{ext}"));
                s.to_string_lossy().into_owned()
            }
        });
    if let Some(p) = &chosen {
        scope().grant_file(p);
    }
    chosen
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

/// Rename a file/folder in place. `to` is the full new path. Refuses to
/// overwrite an existing entry.
#[tauri::command]
async fn rename_path(from: String, to: String) -> Result<String, String> {
    scope().check_root(&from)?;
    scope().check_root(&to)?;
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
    move_path(Path::new(&from), Path::new(&to))?;
    Ok(to)
}

/// Rename, falling back to copy+delete when source and destination sit on
/// different volumes (fs::rename cannot cross them).
fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    match fs::rename(from, to) {
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            if from.is_dir() {
                if let Err(e) = copy_dir(from, to) {
                    let _ = fs::remove_dir_all(to); // no half-copied tree left behind
                    return Err(friendly_io(e));
                }
                fs::remove_dir_all(from).map_err(friendly_io)
            } else {
                fs::copy(from, to).map_err(friendly_io)?;
                fs::remove_file(from).map_err(friendly_io)
            }
        }
        r => r.map_err(friendly_io),
    }
}

/// Move `src` into `dest_dir`. Returns the new path. Refuses to overwrite, and
/// refuses to move a folder inside itself.
#[tauri::command]
async fn move_into(src: String, dest_dir: String) -> Result<String, String> {
    scope().check_root(&src)?;
    scope().check_root(&dest_dir)?;
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
    move_path(src_p, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Create a new subfolder, deduping the name if it already exists.
#[tauri::command]
async fn create_folder(dir: String, name: String) -> Result<String, String> {
    scope().check_root(&dir)?;
    let safe = safe_file_name(&name, "New Folder");
    let target = unique_path(&dir, &safe);
    fs::create_dir(&target).map_err(friendly_io)?;
    Ok(target.to_string_lossy().into_owned())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            // Recreate the link itself. Copying through it could pull in an
            // entire external tree — or die on a dangling link mid-copy.
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(entry.path())?, &dest)?;
        } else if ft.is_dir() {
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
    scope().check_root(&path)?;
    let p = Path::new(&path);
    let dir = p
        .parent()
        .ok_or("Invalid path")?
        .to_string_lossy()
        .into_owned();
    let name = p
        .file_name()
        .ok_or("Invalid path")?
        .to_string_lossy()
        .into_owned();
    let (stem, ext) = split_name(&name);
    let target = unique_path(&dir, &format!("{stem} copy{ext}"));
    let meta = fs::symlink_metadata(p).map_err(friendly_io)?;
    if meta.file_type().is_symlink() {
        // A copy of a link is another link, not a copy of what it points at.
        #[cfg(unix)]
        std::os::unix::fs::symlink(fs::read_link(p).map_err(friendly_io)?, &target)
            .map_err(friendly_io)?;
    } else if meta.is_dir() {
        if let Err(e) = copy_dir(p, &target) {
            let _ = fs::remove_dir_all(&target); // no half-copied tree left behind
            return Err(friendly_io(e));
        }
    } else {
        fs::copy(p, &target).map_err(friendly_io)?;
    }
    Ok(target.to_string_lossy().into_owned())
}

/// Move a file/folder to the OS Trash (recoverable) rather than deleting it.
#[tauri::command]
async fn trash_path(path: String) -> Result<(), String> {
    scope().check_root(&path)?;
    trash::delete(&path).map_err(|_| {
        // trash::Error's Display is a Debug dump — not for users' eyes.
        let name = Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        format!("“{name}” couldn’t be moved to the Trash — this volume may not have one.")
    })
}

/// Show the item in Finder / Explorer / the desktop file manager.
#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    scope().check(&path)?;
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// Open the item with the OS default application.
#[tauri::command]
async fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    scope().check(&path)?;
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

/// Quick Open cap. Kept in step with `LIST_CAP` in src/backend.ts — the
/// frontend treats a maxed-out index as non-authoritative.
const MAX_LISTED: usize = 20_000;

fn list_all_capped(root: &str, cap: usize) -> Vec<FileHit> {
    let root_p = Path::new(root);
    let mut out = Vec::new();
    for entry in walker(root).build().flatten() {
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
            // A workspace pointed at a home directory must not ship a
            // six-figure JSON payload into the webview.
            if out.len() >= cap {
                break;
            }
        }
    }
    out.sort_by_key(|f| f.rel.to_lowercase());
    out
}

/// Recursively list every markdown/image file under `root` (for Quick Open).
#[tauri::command]
async fn list_all(root: String) -> Result<Vec<FileHit>, String> {
    scope().check_root(&root)?;
    Ok(list_all_capped(&root, MAX_LISTED))
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
    scope().check_root(&root)?;
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
                hits.lock().unwrap_or_else(|e| e.into_inner()).extend(local);
            }
            WalkState::Continue
        })
    });

    // Never unwrap_or_default here: losing the Arc race would silently report
    // "no results" for a query that had plenty.
    let mut out = match Arc::try_unwrap(hits) {
        Ok(m) => m.into_inner().unwrap_or_else(|e| e.into_inner()),
        Err(a) => std::mem::take(&mut *a.lock().unwrap_or_else(|e| e.into_inner())),
    };
    // Parallel results arrive unordered — group by file, then line.
    out.sort_by(|a, b| a.rel.cmp(&b.rel).then(a.line.cmp(&b.line)));
    // Workers quit *at* the cap, so exactly-MAX_HITS results are partial too.
    let truncated = out.len() >= MAX_HITS;
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
        // packed-refs: `git gc`/`pack-refs` moves every ref there — without
        // it, a post-gc commit would update no badge until the next focus.
        Some("HEAD" | "index" | "ORIG_HEAD" | "MERGE_HEAD" | "refs" | "packed-refs")
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

/// True for changes the sidebar can actually put a badge on: markdown, images,
/// and directories — a dirty submodule *is* the change, even though you can't
/// drill into it from the parent's status.
///
/// Everything else is dropped. A folder dot that leads nowhere is worse than no
/// dot, and in a repo full of source this also keeps the payload small. The
/// extension test comes first, but a directory qualifies regardless of dots in
/// its name — `vendor.v2` is a perfectly good submodule name, and skipping it
/// meant its changed documents were never found. The `stat` this costs is per
/// *kept-or-directory* candidate, once per debounced refresh.
fn shows_in_tree(path: &Path) -> bool {
    shown_ext(path) || path.is_dir()
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
        let path = if prefix.is_empty() {
            Path::new(workspace).join(rel)
        } else if let Some(sub) = rel.strip_prefix(prefix) {
            Path::new(workspace).join(sub)
        } else {
            // Outside the opened folder — keep it addressable rather than
            // dropping it, even though no row will match.
            Path::new(repo_root).join(rel)
        };
        if !shows_in_tree(&path) {
            continue;
        }
        // Cap only what we keep, so a repo with 20k changed source files still
        // reports its handful of changed documents.
        if out.len() >= MAX_GIT_ENTRIES {
            return (out, true);
        }
        out.push(GitEntry {
            path: path.to_string_lossy().into_owned(),
            status: classify_status(x, y),
        });
    }
    (out, false)
}

const STATUS_ARGS: [&str; 4] = ["status", "--porcelain", "-z", "--untracked-files=all"];

/// A dirty submodule shows up in its parent's status as a single *directory*
/// entry — the parent never says which file inside changed. So ask each dirty
/// submodule directly and fold its answers in. Only submodules that are already
/// reported as changed get a second `git` call, so the cost tracks real work.
fn expand_submodules(entries: &mut Vec<GitEntry>, depth: u8) {
    if depth == 0 {
        return;
    }
    let dirs: Vec<String> = entries
        .iter()
        .filter(|e| Path::new(&e.path).is_dir())
        .map(|e| e.path.clone())
        .collect();
    for dir in dirs {
        // Same flags as the top-level status: without --ignore-submodules a
        // nested submodule's untracked build output would re-report the very
        // noise the top level deliberately suppresses.
        let mut args = STATUS_ARGS.to_vec();
        args.push("--ignore-submodules=untracked");
        let Some(raw) = git_output(&dir, &args) else {
            continue;
        };
        // Inside the submodule, porcelain paths are relative to *its* root.
        let (mut nested, _) = parse_porcelain(&dir, &dir, "", &raw);
        expand_submodules(&mut nested, depth - 1); // submodules of submodules
        entries.append(&mut nested);
    }
}

/// stdout regardless of exit status. `git diff` variants signal "differences
/// found" with a non-zero code, which isn't a failure for our purposes.
/// Drop directory marks that lead nowhere.
///
/// A submodule is reported by its parent as one directory entry, and it can be
/// "modified" for reasons the sidebar can never show you — edits to source
/// files, or simply sitting at a different commit. Marking the folder anyway
/// produces the one thing worse than no mark: a dot you cannot chase. So after
/// expansion, a directory keeps its mark only if some file inside it is one this
/// app can actually open.
///
/// The trade is deliberate: mad stops telling you a submodule has non-document
/// changes. It could not have shown you them, and a git tool does that job.
fn drop_marks_that_lead_nowhere(entries: &mut Vec<GitEntry>) {
    let files: Vec<String> = entries
        .iter()
        .filter(|e| !Path::new(&e.path).is_dir())
        .map(|e| e.path.clone())
        .collect();
    entries.retain(|e| {
        if !Path::new(&e.path).is_dir() {
            return true;
        }
        let prefix = format!("{}/", e.path);
        files.iter().any(|f| f.starts_with(&prefix))
    });
}

fn git_output_lenient(dir: &str, args: &[&str]) -> Option<String> {
    let out = git_run(dir, args)?;
    // Lossy: one non-UTF-8 byte anywhere must not blank the whole answer.
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Absolute path of a working git, probed once per launch. None ⇒ git
/// features stay quietly off.
///
/// A Finder-launched app inherits a minimal PATH (`/usr/bin:/bin:…`):
/// Homebrew's git is invisible there, and `/usr/bin/git` is Apple's Command
/// Line Tools shim — invoking it *without* the tools installed pops the OS
/// "install developer tools?" dialog, which this app would otherwise trigger
/// on every save and window focus. So probe the common real locations first,
/// and only trust the PATH shim when xcode-select says the tools exist.
fn git_binary() -> Option<&'static str> {
    static BIN: OnceLock<Option<String>> = OnceLock::new();
    BIN.get_or_init(|| {
        let works = |bin: &str| {
            std::process::Command::new(bin)
                .arg("--version")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        for cand in ["/opt/homebrew/bin/git", "/usr/local/bin/git"] {
            if works(cand) {
                return Some(cand.to_string());
            }
        }
        let clt_installed = std::process::Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(!cfg!(target_os = "macos")); // only macOS has the shim trap
        if clt_installed && works("git") {
            return Some("git".to_string());
        }
        None
    })
    .as_deref()
}

/// A status against a dead network mount must not pin a worker forever.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// Run git with a consistent env and a hard timeout. On timeout the helper
/// thread (and its child) is abandoned — it dies with its blocked IO, which
/// beats wedging the caller.
fn git_run(dir: &str, args: &[&str]) -> Option<std::process::Output> {
    let mut cmd = std::process::Command::new(git_binary()?);
    cmd.current_dir(dir)
        .args(args)
        // Paths this app passes are literal file names, never patterns —
        // without this, discarding "[draft] plan.md" globs, matches nothing
        // in HEAD, and the file is trashed instead of restored.
        .env("GIT_LITERAL_PATHSPECS", "1")
        // `git status` normally refreshes .git/index as a side effect; the
        // watcher sees that write, refreshes status, which writes again —
        // a subprocess every debounce interval, forever. Read-only status.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });
    rx.recv_timeout(GIT_TIMEOUT).ok()?.ok()
}

/// Unified diff for one file against the last commit, staged changes included.
/// A file that was never committed is rendered wholly added.
#[tauri::command]
async fn git_diff(path: String) -> Option<String> {
    scope().check(&path).ok()?;
    let p = Path::new(&path);
    let dir = p.parent()?.to_string_lossy().into_owned();
    // Confirm we're in a repository first, or an untracked file outside one
    // would fall through and be reported as entirely new.
    git_output(&dir, &["rev-parse", "--show-toplevel"])?;
    if let Some(d) = git_output_lenient(&dir, &["diff", "HEAD", "--no-color", "--", &path]) {
        if !d.trim().is_empty() {
            return Some(d);
        }
    }
    // An empty diff for a *committed* file means it simply matches HEAD. Only a
    // file with no committed version at all reads as wholly added — without this
    // guard, an unchanged document would render as one giant addition.
    if git_in_head(&dir, &path) {
        return None;
    }
    // Synthesized rather than diffing against /dev/null, which isn't portable.
    let text = fs::read_to_string(p).ok()?;
    if text.is_empty() {
        return None;
    }
    let name = p.file_name()?.to_string_lossy().into_owned();
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!(
        "--- /dev/null\n+++ b/{name}\n@@ -0,0 +1,{} @@\n",
        lines.len()
    );
    for l in lines {
        out.push('+');
        out.push_str(l);
        out.push('\n');
    }
    Some(out)
}

/// Does `path` exist in the last commit? Decides whether "discard" can mean
/// "restore" at all, or whether the file has nowhere to go back to.
fn git_in_head(dir: &str, path: &str) -> bool {
    git_output(dir, &["ls-tree", "HEAD", "--name-only", "--", path])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Throw away a file's uncommitted changes.
///
/// Returns `"restored"` when the file was put back to its committed state, or
/// `"trashed"` when it had never been committed and so went to the OS Trash
/// instead — there is no earlier version to restore, and silently deleting
/// someone's new document is not an acceptable reading of "discard".
#[tauri::command]
async fn git_discard(path: String) -> Result<String, String> {
    scope().check(&path)?;
    let p = Path::new(&path);
    let dir = p
        .parent()
        .ok_or("Invalid path")?
        .to_string_lossy()
        .into_owned();
    if git_in_head(&dir, &path) {
        // --staged --worktree so "discard" means the same thing whether or not
        // the change had been staged.
        git_output(&dir, &["restore", "--staged", "--worktree", "--", &path])
            .ok_or("git restore failed")?;
        Ok("restored".into())
    } else {
        let _ = git_output(&dir, &["restore", "--staged", "--", &path]); // unstage if added
        trash::delete(&path).map_err(|_| {
            format!(
                "“{}” couldn’t be moved to the Trash — this volume may not have one.",
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone())
            )
        })?;
        Ok("trashed".into())
    }
}

/// What `git_discard` would do to `path`: `"restore"` (committed — goes back
/// to HEAD) or `"trash"` (nothing to go back to). The UI words its
/// confirmation from this rather than guessing from the status letter — a
/// renamed file's letter says "committed" but its *new* path is not in HEAD,
/// and a dialog promising a restore must not deliver a trashing.
#[tauri::command]
async fn git_discard_kind(path: String) -> Result<String, String> {
    scope().check(&path)?;
    let dir = Path::new(&path)
        .parent()
        .ok_or("Invalid path")?
        .to_string_lossy()
        .into_owned();
    Ok(if git_in_head(&dir, &path) {
        "restore".into()
    } else {
        "trash".into()
    })
}

fn git_output(dir: &str, args: &[&str]) -> Option<String> {
    let out = git_run(dir, args)?;
    if !out.status.success() {
        return None;
    }
    // Lossy: a single Latin-1 filename in the porcelain stream must not erase
    // every badge in the sidebar.
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Pending git changes under `root`, or None when it isn't a repository (or git
/// isn't installed). Shells out to git rather than linking libgit2 — this runs
/// on a change event, not in a hot loop.
#[tauri::command]
async fn git_status(root: String) -> Option<GitInfo> {
    scope().check_root(&root).ok()?;
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
    let mut args = STATUS_ARGS.to_vec();
    // Untracked files *inside* a submodule are nearly always build output that
    // nobody gitignored, and they make git report the whole submodule as
    // modified when nothing was actually changed — a mark you can't chase.
    // Genuine tracked edits and commit differences are still reported, and a
    // submodule reported for those reasons still gets expanded below, so a
    // modified document inside one is still found.
    args.push("--ignore-submodules=untracked");
    args.extend_from_slice(&["--", "."]);
    let raw = git_output(&root, &args)?;
    let (mut entries, truncated) = parse_porcelain(&root, &repo, &prefix, &raw);
    expand_submodules(&mut entries, 3);
    drop_marks_that_lead_nowhere(&mut entries);
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

/// Rebuild a watcher event path onto the root the user opened. notify
/// canonicalizes its watch root and FSEvents reports canonical paths, so a
/// workspace opened as `/tmp/notes` gets events for `/private/tmp/notes` —
/// which match nothing the frontend holds unless mapped back.
fn remap_event_path(canon_root: &Path, user_root: &Path, p: PathBuf) -> PathBuf {
    match p.strip_prefix(canon_root) {
        Ok(rel) => user_root.join(rel),
        Err(_) => p,
    }
}

/// Watch `path` recursively and emit debounced `fs-change` events so the tree
/// and the open document stay in step with edits made outside the app.
/// Async: swapping watchers joins an FSEvents run loop — not main-thread work.
#[tauri::command]
async fn watch_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    scope().check_root(&path)?;
    let canon_root = fs::canonicalize(&path).map_err(friendly_io)?;
    let state = app.state::<FsWatcher>();
    // Drop the previous watcher first; that closes its channel and ends the
    // debounce thread below.
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&path), notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);

    let handle = app.clone();
    let root = PathBuf::from(&path);
    std::thread::spawn(move || {
        const MAX_REPORTED: usize = 200;
        let collect =
            |set: &mut BTreeSet<PathBuf>, git: &mut bool, res: notify::Result<notify::Event>| {
                let Ok(ev) = res else { return };
                for p in ev.paths {
                    // FSEvents speaks canonical paths; the app speaks the
                    // user's. Translate before any filter or comparison.
                    let p = remap_event_path(&canon_root, &root, p);
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
                    if p.file_name()
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
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(remaining.min(Duration::from_millis(160))) {
                    Ok(ev) => collect(&mut paths, &mut git, ev),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break, // quiet
                    Err(_) => return,                                         // watcher dropped
                }
            }
            // The workspace itself may be what changed: deleted or renamed
            // away. Tell the frontend instead of going silently stale.
            if !root.exists() {
                let _ = handle.emit("root-gone", ());
                return;
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

/// One quit attempt in flight. `acked` records that the webview received the
/// flush-and-exit event and now owns the flow; `generation` invalidates the
/// backstop of a superseded attempt.
struct ExitFlow(Arc<ExitFlowState>);

#[derive(Default)]
struct ExitFlowState {
    acked: AtomicBool,
    generation: AtomicUsize,
}

/// Should the exit backstop force-quit? Only when its own attempt is still
/// current and the webview never acknowledged it. There is deliberately no
/// wall-clock cap after an ack: the flush may legitimately sit on a native
/// dialog (unsaved draft, save conflict) for as long as the user ponders it,
/// and a timer racing that dialog is how work gets destroyed. A webview that
/// acks and then dies is recovered by the *next* quit attempt — a fresh
/// generation it can no longer ack.
fn backstop_fires(spawned_gen: usize, current_gen: usize, acked: bool) -> bool {
    spawned_gen == current_gen && !acked
}

/// Called by the frontend once pending edits are flushed; exits for real.
#[tauri::command]
fn confirm_exit(app: tauri::AppHandle) {
    app.exit(0);
}

/// First thing the frontend calls on `flush-and-exit`: proves the webview is
/// alive, which disarms the force-quit backstop for this attempt.
#[tauri::command]
fn exit_ack(state: tauri::State<ExitFlow>) {
    state.0.acked.store(true, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Recents(Mutex::new(Vec::new())));
            app.manage(MenuState {
                gated: Mutex::new(Vec::new()),
                enabled: Mutex::new((false, false, false)),
            });
            app.manage(FsWatcher(Mutex::new(None)));
            app.manage(ExitFlow(Arc::new(ExitFlowState::default())));
            rebuild_menu(&handle)?;
            // Reading the recents means stat'ing every entry, and a stale
            // network mount can hang a stat for its full mount timeout — so
            // none of it may run on the main thread before the window shows.
            // For healthy disks this finishes long before the webview's first
            // invoke; a hung mount degrades to a Welcome-screen launch.
            let bg = app.handle().clone();
            std::thread::spawn(move || {
                let recents = load_recents(&bg);
                // Recents seed the scope: every entry was dialog-granted when
                // first opened, and push_recent refuses anything that wasn't.
                for r in &recents {
                    scope().grant_root(r);
                }
                let has_any = !recents.is_empty();
                *bg.state::<Recents>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = recents;
                if has_any {
                    let main = bg.clone();
                    let _ = bg.run_on_main_thread(move || {
                        let _ = rebuild_menu(&main);
                    });
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            // Menu items that are just a named signal to the frontend.
            const FORWARD: [(&str, &str); 20] = [
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
                ("goto_heading", "menu-goto-heading"),
                ("toggle_source", "menu-toggle-source"),
                ("toggle_split", "menu-toggle-split"),
                ("toggle_sidebar", "menu-toggle-sidebar"),
                ("toggle_theme", "menu-toggle-theme"),
                ("show_changes", "menu-show-changes"),
                ("check_updates", "menu-check-updates"),
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
                        state.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    }
                    save_recents(app, &[]);
                    let _ = rebuild_menu(app);
                }
                "close_window" => {
                    // Through close(), not destroy(): the frontend's
                    // close-requested flush still runs.
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.close();
                    }
                }
                "help_github" => {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app
                        .opener()
                        .open_url("https://github.com/digitaljohn/mad", None::<&str>);
                }
                "help_issue" => {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app.opener().open_url(
                        "https://github.com/digitaljohn/mad/issues/new",
                        None::<&str>,
                    );
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
            git_diff,
            git_discard,
            git_discard_kind,
            watch_folder,
            confirm_exit,
            exit_ack
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // User-initiated quit (⌘Q): hold the exit so the frontend can
            // flush edits and warn about an unsaved draft. It acks receipt
            // immediately (exit_ack), then calls confirm_exit to proceed — or
            // simply stands down to stay. confirm_exit's app.exit(0) re-enters
            // here with code Some(0) and falls straight through.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                    let st = app.state::<ExitFlow>().0.clone();
                    let gen = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
                    st.acked.store(false, Ordering::SeqCst);
                    let _ = app.emit("flush-and-exit", ());
                    // Backstop for a webview that never answers at all (dead,
                    // hung, or not yet loaded — no user edits can exist then).
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(5));
                        let current = st.generation.load(Ordering::SeqCst);
                        if backstop_fires(gen, current, st.acked.load(Ordering::SeqCst)) {
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
    use std::task::{Context, Poll, Waker};

    /// The filesystem commands are `async` only so Tauri runs them off the UI
    /// thread — they never actually yield, so one poll completes them.
    fn run<F: Future>(fut: F) -> F::Output {
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
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
            // Grant the directory so every test runs through the real scope
            // checks — exactly as a dialog-granted workspace would.
            scope().grant_root(&p.to_string_lossy());
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
        assert_eq!(
            fs::read_to_string(format!("{dcopy}/deep/x.md")).unwrap(),
            "deep"
        );
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

    // ------------------------------------------------------------- recents

    #[test]
    fn recents_round_trip_and_drop_folders_that_vanished() {
        let t = TempDir::new();
        let file = t.path().join("recents.json");
        let gone = t.s("deleted-folder");
        fs::create_dir(t.path().join("kept")).unwrap();
        let kept = t.s("kept");

        write_recents(&file, &[kept.clone(), gone.clone()]);
        // The vanished folder must not come back as a dead menu entry.
        assert_eq!(read_recents(&file), vec![kept]);
    }

    #[test]
    fn reading_recents_tolerates_a_missing_or_corrupt_file() {
        let t = TempDir::new();
        assert_eq!(
            read_recents(&t.path().join("absent.json")),
            Vec::<String>::new()
        );
        let bad = t.path().join("bad.json");
        fs::write(&bad, "{not json").unwrap();
        assert_eq!(read_recents(&bad), Vec::<String>::new());
        // Right JSON, wrong shape.
        fs::write(&bad, "{\"a\":1}").unwrap();
        assert_eq!(read_recents(&bad), Vec::<String>::new());
    }

    #[test]
    fn pushing_a_recent_moves_it_to_the_front_without_duplicating() {
        let mut list = vec!["/b".to_string(), "/c".to_string()];
        push_recent_list(&mut list, "/a".into());
        assert_eq!(list, ["/a", "/b", "/c"]);
        // Re-opening /c promotes it rather than adding a second entry.
        push_recent_list(&mut list, "/c".into());
        assert_eq!(list, ["/c", "/a", "/b"]);
    }

    #[test]
    fn the_recents_list_is_capped() {
        let mut list = Vec::new();
        for i in 0..MAX_RECENTS + 5 {
            push_recent_list(&mut list, format!("/f{i}"));
        }
        assert_eq!(list.len(), MAX_RECENTS);
        assert_eq!(list[0], format!("/f{}", MAX_RECENTS + 4));
    }

    // ------------------------------------------------------- small helpers

    #[test]
    fn status_codes_collapse_to_the_most_alarming_meaning() {
        // Conflicts outrank everything, then deletion, then addition.
        for (x, y) in [('U', 'U'), ('A', 'A'), ('D', 'D'), ('U', 'D'), ('A', 'U')] {
            assert_eq!(classify_status(x, y), "conflict", "{x}{y}");
        }
        assert_eq!(classify_status('?', '?'), "untracked");
        assert_eq!(classify_status('A', ' '), "added");
        assert_eq!(classify_status('A', 'M'), "added");
        assert_eq!(classify_status('D', ' '), "deleted");
        assert_eq!(classify_status(' ', 'D'), "deleted");
        assert_eq!(classify_status('M', 'D'), "deleted");
        assert_eq!(classify_status('R', ' '), "renamed");
        assert_eq!(classify_status('C', ' '), "renamed");
        assert_eq!(classify_status(' ', 'M'), "modified");
        assert_eq!(classify_status('M', ' '), "modified");
        assert_eq!(classify_status('T', ' '), "modified");
    }

    #[test]
    fn only_files_the_sidebar_shows_count_as_visible() {
        assert!(shows_in_tree(Path::new("/w/a.md")));
        assert!(shows_in_tree(Path::new("/w/a.MARKDOWN")));
        assert!(shows_in_tree(Path::new("/w/p.PNG")));
        assert!(!shows_in_tree(Path::new("/w/main.c")));
        assert!(!shows_in_tree(Path::new("/w/Makefile"))); // no extension, not a dir
    }

    #[test]
    fn a_directory_counts_as_visible_so_submodules_can_be_marked() {
        let t = TempDir::new();
        fs::create_dir(t.path().join("vendor")).unwrap();
        assert!(shows_in_tree(&t.path().join("vendor")));
    }

    #[test]
    fn junk_directories_are_named_explicitly() {
        for d in ["node_modules", "target", "dist", "build", ".git"] {
            assert!(is_junk_dir(d), "{d}");
        }
        assert!(!is_junk_dir("docs"));
        assert!(!is_junk_dir("distribution"));
    }

    #[test]
    fn markdown_detection_is_case_insensitive() {
        assert!(is_markdown(Path::new("a.md")));
        assert!(is_markdown(Path::new("a.MD")));
        assert!(is_markdown(Path::new("a.Markdown")));
        assert!(!is_markdown(Path::new("a.mdx")));
        assert!(!is_markdown(Path::new("md")));
    }

    #[test]
    fn a_stamp_changes_with_content_and_is_empty_when_absent() {
        let t = TempDir::new();
        let p = t.path().join("f.md");
        assert_eq!(stamp_of(&p), "", "a missing file has a stable empty stamp");
        fs::write(&p, "a").unwrap();
        let first = stamp_of(&p);
        assert!(!first.is_empty());
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&p, "much longer content").unwrap();
        assert_ne!(stamp_of(&p), first);
    }

    #[test]
    fn splitting_a_name_keeps_dotfiles_whole() {
        assert_eq!(split_name("a.md"), ("a".into(), ".md".into()));
        assert_eq!(split_name("a.b.md"), ("a.b".into(), ".md".into()));
        assert_eq!(split_name("README"), ("README".into(), "".into()));
        // A leading dot is the whole name, not an extension.
        assert_eq!(split_name(".gitignore"), (".gitignore".into(), "".into()));
    }

    #[test]
    fn unique_path_walks_past_every_taken_name() {
        let t = TempDir::new();
        let dir = t.path().to_string_lossy().into_owned();
        t.write("n.md", "");
        t.write("n 2.md", "");
        assert!(unique_path(&dir, "n.md").ends_with("n 3.md"));
    }

    #[test]
    fn reading_an_oversized_image_is_refused_rather_than_buffered() {
        let t = TempDir::new();
        let p = t.write("huge.png", "");
        // 64 MiB + 1 of zeros, written sparsely.
        let f = fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_len(64 * 1024 * 1024 + 1).unwrap();
        drop(f);
        assert!(run(read_image(p)).is_err());
    }

    #[test]
    fn reading_a_missing_image_is_an_error() {
        let t = TempDir::new();
        assert!(run(read_image(t.s("nope.png"))).is_err());
    }

    #[test]
    fn an_image_round_trips_through_base64() {
        let t = TempDir::new();
        let dir = t.path().to_string_lossy().into_owned();
        let name = run(save_image(dir, "p.png".into(), "aGVsbG8=".into())).unwrap();
        assert_eq!(name, "p.png");
        assert_eq!(fs::read(t.path().join("p.png")).unwrap(), b"hello");
        let b64 = run(read_image(t.s("p.png"))).unwrap();
        assert_eq!(b64, "aGVsbG8=");
    }

    #[test]
    fn invalid_base64_is_rejected_before_touching_the_disk() {
        let t = TempDir::new();
        let dir = t.path().to_string_lossy().into_owned();
        assert!(run(save_image(dir, "p.png".into(), "not base64!".into())).is_err());
        assert!(!t.path().join("p.png").exists());
    }

    #[test]
    fn reading_a_non_utf8_file_explains_itself() {
        let t = TempDir::new();
        let p = t.path().join("binary.md");
        fs::write(&p, [0xff, 0xfe, 0x00]).unwrap();
        let err = run(read_file(p.to_string_lossy().into_owned())).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
    }

    #[test]
    fn writing_into_a_missing_directory_fails_without_leaving_a_temp_file() {
        let t = TempDir::new();
        let target = t.s("no-such-dir/note.md");
        assert!(run(write_file(target, "x".into(), None)).is_err());
        assert_eq!(names(t.path()), Vec::<String>::new());
    }

    #[test]
    fn file_stamp_matches_the_one_returned_with_the_content() {
        let t = TempDir::new();
        let p = t.write("f.md", "body\n");
        let data = run(read_file(p.clone())).unwrap();
        assert_eq!(run(file_stamp(p)), Ok(data.stamp));
    }

    #[test]
    fn an_empty_search_query_returns_nothing_without_walking() {
        let t = TempDir::new();
        t.write("a.md", "needle\n");
        let res = run(search_files(t.s(""), "   ".into(), false, false, false)).unwrap();
        assert!(res.hits.is_empty());
        assert!(!res.truncated);
    }

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
        let (entries, _) = parse_porcelain("/var/work/docs", "/private/var/work", "docs/", raw);
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
    fn only_changes_the_sidebar_can_show_are_reported() {
        // A folder dot must always lead somewhere, so changes to files the tree
        // never renders are dropped rather than left as an untraceable mark.
        let raw = " M docs/a.md\0 M firmware/main.c\0?? notes/pic.png\0 M Makefile\0";
        let (entries, _) = parse_porcelain("/w", "/w", "", raw);
        let got: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(got, vec!["/w/docs/a.md", "/w/notes/pic.png"]);
    }

    #[test]
    fn the_entry_cap_counts_only_what_is_kept() {
        // 6000 changed source files must not crowd out the one document.
        let mut raw = String::new();
        for i in 0..6000 {
            raw.push_str(&format!(" M src/f{i}.c\0"));
        }
        raw.push_str(" M README.md\0");
        let (entries, truncated) = parse_porcelain("/w", "/w", "", &raw);
        assert!(!truncated);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/w/README.md");
    }

    /// Shells out to real git, with a real submodule, to prove the three cases
    /// the sidebar has to get right.
    #[test]
    fn git_status_descends_into_dirty_submodules() {
        let t = TempDir::new();
        let run = |dir: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .current_dir(dir)
                // Local submodule paths need this on modern git.
                .args(["-c", "protocol.file.allow=always"])
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed in {dir:?}");
        };
        let init = |dir: &Path| {
            run(dir, &["init", "--quiet", "-b", "main"]);
            run(dir, &["config", "user.email", "t@example.com"]);
            run(dir, &["config", "user.name", "t"]);
        };

        // An inner repo that will become a submodule.
        let inner = t.path().join("inner");
        fs::create_dir_all(inner.join("docs")).unwrap();
        init(&inner);
        fs::write(inner.join("docs/inner.md"), "one\n").unwrap();
        run(&inner, &["add", "-A"]);
        run(&inner, &["commit", "--quiet", "-m", "init"]);

        // The outer repo: a nested document, a source file, and the submodule.
        let outer = t.path().join("outer");
        fs::create_dir_all(outer.join("docs/deep")).unwrap();
        fs::create_dir_all(outer.join("firmware")).unwrap();
        init(&outer);
        fs::write(outer.join("docs/deep/nested.md"), "spec\n").unwrap();
        fs::write(outer.join("firmware/main.c"), "int main(){}\n").unwrap();
        run(
            &outer,
            &["submodule", "add", "--quiet", "../inner", "vendor"],
        );
        run(&outer, &["add", "-A"]);
        run(&outer, &["commit", "--quiet", "-m", "init"]);

        // Dirty one of each kind.
        fs::write(outer.join("docs/deep/nested.md"), "spec changed\n").unwrap();
        fs::write(outer.join("firmware/main.c"), "// changed\n").unwrap();
        fs::write(outer.join("vendor/docs/inner.md"), "one\ntwo\n").unwrap();

        let info = run_cmd(&outer);
        let by: std::collections::HashMap<String, &str> = info
            .entries
            .iter()
            .map(|e| (e.path.clone(), e.status))
            .collect();
        let at = |rel: &str| outer.join(rel).to_string_lossy().into_owned();

        // Nested documents: badged directly.
        assert_eq!(by.get(&at("docs/deep/nested.md")), Some(&"modified"));
        // The submodule directory is itself the change, so it keeps its mark…
        assert_eq!(by.get(&at("vendor")), Some(&"modified"));
        // …and we descend into it so the file inside is findable too.
        assert_eq!(by.get(&at("vendor/docs/inner.md")), Some(&"modified"));
        // Source the sidebar can't render is not reported at all.
        assert!(!by.contains_key(&at("firmware/main.c")));
        assert!(by.keys().all(|k| !k.ends_with(".c")));
    }

    /// `git_status` on a path, driven through the async command wrapper.
    fn run_cmd(dir: &Path) -> GitInfo {
        run(git_status(dir.to_string_lossy().into_owned())).expect("should be a repo")
    }

    #[test]
    fn untracked_junk_inside_a_submodule_is_not_a_change() {
        // The common false positive: build output nobody gitignored makes git
        // call the whole submodule "modified" though nothing was edited and the
        // recorded commit still matches. Reporting it puts a mark on a folder
        // with nothing to find inside.
        let t = TempDir::new();
        let g = |dir: &Path, args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .current_dir(dir)
                    .args(["-c", "protocol.file.allow=always"])
                    .args(args)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false),
                "git {args:?} failed"
            );
        };
        let init = |dir: &Path| {
            g(dir, &["init", "--quiet", "-b", "main"]);
            g(dir, &["config", "user.email", "t@example.com"]);
            g(dir, &["config", "user.name", "t"]);
        };

        let inner = t.path().join("inner");
        fs::create_dir_all(&inner).unwrap();
        init(&inner);
        fs::write(inner.join("kept.md"), "one\n").unwrap();
        g(&inner, &["add", "-A"]);
        g(&inner, &["commit", "--quiet", "-m", "init"]);

        let outer = t.path().join("outer");
        fs::create_dir_all(&outer).unwrap();
        init(&outer);
        fs::write(outer.join("top.md"), "top\n").unwrap();
        g(
            &outer,
            &["submodule", "add", "--quiet", "../inner", "vendor"],
        );
        g(&outer, &["add", "-A"]);
        g(&outer, &["commit", "--quiet", "-m", "init"]);

        // Only untracked build output inside the submodule.
        fs::write(outer.join("vendor/build.o"), "junk\n").unwrap();
        fs::write(outer.join("vendor/scratch.md"), "untracked doc\n").unwrap();

        let info = run_cmd(&outer);
        assert!(
            info.entries.is_empty(),
            "a submodule dirtied only by untracked content is not a change: {:?}",
            info.entries
        );

        // But a genuinely edited tracked document inside it still surfaces,
        // both as the submodule mark and as the file itself.
        fs::write(outer.join("vendor/kept.md"), "one\ntwo\n").unwrap();
        let info = run_cmd(&outer);
        let paths: Vec<&str> = info.entries.iter().map(|e| e.path.as_str()).collect();
        let vendor = outer.join("vendor").to_string_lossy().into_owned();
        let kept = outer.join("vendor/kept.md").to_string_lossy().into_owned();
        assert!(paths.contains(&vendor.as_str()), "{paths:?}");
        assert!(paths.contains(&kept.as_str()), "{paths:?}");
    }

    /// A repo with one committed file, returned as (repo dir, file path).
    fn repo_with_commit(t: &TempDir) -> (PathBuf, String) {
        let dir = t.path().to_path_buf();
        let g = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .current_dir(&dir)
                    .args(args)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false),
                "git {args:?} failed"
            );
        };
        g(&["init", "--quiet", "-b", "main"]);
        g(&["config", "user.email", "t@example.com"]);
        g(&["config", "user.name", "t"]);
        let file = t.write("doc.md", "one\ntwo\n");
        g(&["add", "-A"]);
        g(&["commit", "--quiet", "-m", "init"]);
        (dir, file)
    }

    #[test]
    fn diff_shows_the_change_against_the_last_commit() {
        let t = TempDir::new();
        let (_dir, file) = repo_with_commit(&t);
        assert!(
            run(git_diff(file.clone())).is_none(),
            "an unchanged file has no diff"
        );

        fs::write(&file, "one\ntwo and a half\n").unwrap();
        let d = run(git_diff(file.clone())).expect("modified file should diff");
        assert!(d.contains("@@"), "expected a hunk header:\n{d}");
        assert!(d.contains("-two"), "expected the old line:\n{d}");
        assert!(d.contains("+two and a half"), "expected the new line:\n{d}");
    }

    #[test]
    fn diff_renders_a_never_committed_file_as_wholly_added() {
        let t = TempDir::new();
        let (_dir, _) = repo_with_commit(&t);
        let fresh = t.write("fresh.md", "alpha\nbeta\n");
        let d = run(git_diff(fresh)).expect("untracked file should diff");
        assert!(d.contains("--- /dev/null"), "{d}");
        assert!(d.contains("@@ -0,0 +1,2 @@"), "{d}");
        assert!(d.contains("+alpha") && d.contains("+beta"), "{d}");
    }

    #[test]
    fn diff_is_none_outside_a_repository() {
        let t = TempDir::new();
        let loose = t.write("loose.md", "not in git\n");
        assert!(run(git_diff(loose)).is_none());
    }

    #[test]
    fn discarding_restores_the_committed_version() {
        let t = TempDir::new();
        let (_dir, file) = repo_with_commit(&t);
        fs::write(&file, "wrecked\n").unwrap();
        assert_eq!(run(git_discard(file.clone())).unwrap(), "restored");
        assert_eq!(fs::read_to_string(&file).unwrap(), "one\ntwo\n");
    }

    #[test]
    fn discarding_also_undoes_a_staged_change() {
        let t = TempDir::new();
        let (dir, file) = repo_with_commit(&t);
        fs::write(&file, "staged edit\n").unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(&dir)
            .args(["add", "-A"])
            .status()
            .unwrap()
            .success());
        assert_eq!(run(git_discard(file.clone())).unwrap(), "restored");
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "one\ntwo\n",
            "--staged --worktree must clear the index too"
        );
        // And the index is clean again, so nothing is left staged.
        let status = run(git_status(dir.to_string_lossy().into_owned())).unwrap();
        assert!(status.entries.is_empty(), "{:?}", status.entries);
    }

    #[test]
    fn a_never_committed_file_has_nothing_to_restore_to() {
        // git_discard trashes these rather than restoring, so assert the
        // decision directly instead of littering the real Trash from a test.
        let t = TempDir::new();
        let (dir, file) = repo_with_commit(&t);
        let d = dir.to_string_lossy().into_owned();
        assert!(git_in_head(&d, &file), "committed file is in HEAD");
        let fresh = t.write("fresh.md", "new\n");
        assert!(!git_in_head(&d, &fresh), "untracked file is not in HEAD");
        // Staging it does not put it in HEAD either — still nothing to go back to.
        assert!(std::process::Command::new("git")
            .current_dir(&dir)
            .args(["add", "fresh.md"])
            .status()
            .unwrap()
            .success());
        assert!(
            !git_in_head(&d, &fresh),
            "staged-but-uncommitted is not in HEAD"
        );
    }

    #[test]
    fn a_submodule_with_only_source_changes_is_left_unmarked() {
        // linux-kernel-shaped case: real tracked edits inside a submodule, none
        // of them files this app can open. A dot there could not be chased.
        let t = TempDir::new();
        let g = |dir: &Path, args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .current_dir(dir)
                    .args(["-c", "protocol.file.allow=always"])
                    .args(args)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false),
                "git {args:?} failed"
            );
        };
        let init = |dir: &Path| {
            g(dir, &["init", "--quiet", "-b", "main"]);
            g(dir, &["config", "user.email", "t@example.com"]);
            g(dir, &["config", "user.name", "t"]);
        };

        let inner = t.path().join("inner");
        fs::create_dir_all(&inner).unwrap();
        init(&inner);
        fs::write(inner.join("driver.c"), "int x;\n").unwrap();
        fs::write(inner.join("guide.md"), "guide\n").unwrap();
        g(&inner, &["add", "-A"]);
        g(&inner, &["commit", "--quiet", "-m", "init"]);

        let outer = t.path().join("outer");
        fs::create_dir_all(&outer).unwrap();
        init(&outer);
        fs::write(outer.join("top.md"), "top\n").unwrap();
        g(
            &outer,
            &["submodule", "add", "--quiet", "../inner", "vendor"],
        );
        g(&outer, &["add", "-A"]);
        g(&outer, &["commit", "--quiet", "-m", "init"]);

        // Only source changed inside the submodule.
        fs::write(outer.join("vendor/driver.c"), "int x; int y;\n").unwrap();
        let info = run_cmd(&outer);
        assert!(
            info.entries.is_empty(),
            "nothing openable changed, so nothing should be marked: {:?}",
            info.entries
        );

        // Add a document change and the submodule earns its mark back.
        fs::write(outer.join("vendor/guide.md"), "guide\nmore\n").unwrap();
        let paths: Vec<String> = run_cmd(&outer)
            .entries
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert!(paths.iter().any(|p| p.ends_with("/vendor")), "{paths:?}");
        assert!(
            paths.iter().any(|p| p.ends_with("/vendor/guide.md")),
            "{paths:?}"
        );
        assert!(!paths.iter().any(|p| p.ends_with(".c")), "{paths:?}");
    }

    #[test]
    fn only_meaningful_git_paths_trigger_a_status_refresh() {
        let root = Path::new("/work");
        assert!(is_git_signal(root, Path::new("/work/.git/HEAD")));
        assert!(is_git_signal(root, Path::new("/work/.git/index")));
        assert!(is_git_signal(root, Path::new("/work/.git/refs/heads/main")));
        // Lock and object churn would fire constantly for no visible change.
        assert!(!is_git_signal(root, Path::new("/work/.git/index.lock")));
        assert!(!is_git_signal(
            root,
            Path::new("/work/.git/objects/ab/cdef")
        ));
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
        assert_eq!(
            by_path.get(abs("nested/deep.md").as_str()),
            Some(&"deleted")
        );
        assert!(!info.truncated);
        // Committed-and-untouched files must not be reported at all.
        assert!(!info
            .entries
            .iter()
            .any(|e| e.path.ends_with("nested/other.md")));

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
        assert!(!in_skipped_dir(
            root,
            Path::new("/Users/x/.notes/sub/today.md")
        ));
        assert!(in_skipped_dir(root, Path::new("/Users/x/.notes/.git/HEAD")));
    }

    // --------------------------------------------------------------- scope

    /// A path in the system temp dir that no test ever granted. Parallel tests
    /// each grant their own TempDir subdirectory, never temp_dir() itself.
    fn denied(rel: &str) -> String {
        std::env::temp_dir()
            .join(format!("mad-denied-{rel}"))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn commands_refuse_paths_outside_every_granted_root() {
        fs::create_dir_all(denied("dir")).unwrap();
        fs::write(denied("dir/secret.md"), "s").unwrap();

        let err = run(write_file(denied("dir/secret.md"), "x".into(), None)).unwrap_err();
        assert!(err.contains("outside the open workspace"), "{err}");
        assert_eq!(fs::read_to_string(denied("dir/secret.md")).unwrap(), "s");

        assert!(run(read_file(denied("dir/secret.md"))).is_err());
        assert!(run(list_dir(denied("dir"))).is_err());
        assert!(run(trash_path(denied("dir/secret.md"))).is_err());
        assert!(run(duplicate_path(denied("dir/secret.md"))).is_err());
        assert!(run(create_file(denied("dir"), "a.md".into())).is_err());
        assert!(run(list_all(denied("dir"))).is_err());

        let _ = fs::remove_dir_all(denied("dir"));
    }

    #[test]
    fn a_granted_file_may_be_read_and_written_but_not_trashed() {
        // The file tier models Save As outside the workspace: the document
        // stays editable, but tree operations never extend to it.
        fs::create_dir_all(denied("grant")).unwrap();
        let file = denied("grant/exported.md");
        fs::write(&file, "v1").unwrap();
        scope().grant_file(&file);

        run(write_file(file.clone(), "v2".into(), None)).unwrap();
        assert_eq!(run(read_file(file.clone())).unwrap().content, "v2");
        assert!(run(file_stamp(file.clone())).is_ok());
        // …but its siblings gain nothing, and destructive ops stay refused.
        assert!(run(read_file(denied("grant/exported 2.md"))).is_err());
        assert!(run(trash_path(file.clone())).is_err());

        let _ = fs::remove_dir_all(denied("grant"));
    }

    #[test]
    fn scope_roots_do_not_leak_to_prefix_sibling_directories() {
        // /ws must not admit /ws2 — starts_with is component-wise.
        let t = TempDir::new();
        fs::create_dir_all(t.path().join("ws")).unwrap();
        scope().grant_root(&t.s("ws"));
        let sibling = format!("{}2", t.s("ws"));
        fs::create_dir_all(&sibling).unwrap();
        fs::write(format!("{sibling}/a.md"), "a").unwrap();
        // The sibling is still inside the TempDir (granted), so probe the
        // component logic directly.
        let c = canonical_target(&format!("{sibling}/a.md")).unwrap();
        let ws = canonical_target(&t.s("ws")).unwrap();
        assert!(!c.starts_with(&ws));
    }

    #[test]
    fn canonical_target_resolves_new_files_and_rejects_traversal() {
        let t = TempDir::new();
        // A file that doesn't exist yet resolves through its parent.
        let fresh = canonical_target(&t.s("new.md")).unwrap();
        assert_eq!(fresh.file_name().unwrap(), "new.md");
        // A missing parent cannot resolve at all.
        assert!(canonical_target(&t.s("no-such-dir/new.md")).is_err());
        // `..` never sneaks through, even when the result would land inside.
        let dodgy = format!("{}/sub/../new.md", t.s(""));
        assert!(canonical_target(&dodgy).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_pointing_out_of_the_workspace_is_outside_it() {
        let t = TempDir::new();
        fs::create_dir_all(denied("target")).unwrap();
        fs::write(denied("target/real.md"), "outside").unwrap();
        std::os::unix::fs::symlink(denied("target/real.md"), t.path().join("link.md")).unwrap();
        // The link sits inside a granted root, but it resolves outside — and
        // membership is decided on the resolved path.
        let err = run(read_file(t.s("link.md"))).unwrap_err();
        assert!(err.contains("outside the open workspace"), "{err}");
        let _ = fs::remove_dir_all(denied("target"));
    }

    // ------------------------------------------------------------- watcher

    #[test]
    fn watcher_events_are_remapped_into_the_users_path_space() {
        // FSEvents reports /private/tmp/… for a workspace opened as /tmp/…;
        // every downstream comparison uses the user's spelling.
        let canon = Path::new("/private/tmp/notes");
        let user = Path::new("/tmp/notes");
        assert_eq!(
            remap_event_path(canon, user, PathBuf::from("/private/tmp/notes/sub/a.md")),
            PathBuf::from("/tmp/notes/sub/a.md")
        );
        // Paths outside the root pass through untouched.
        assert_eq!(
            remap_event_path(canon, user, PathBuf::from("/private/tmp/other/b.md")),
            PathBuf::from("/private/tmp/other/b.md")
        );
    }

    // ---------------------------------------------------------------- menu

    #[test]
    fn duplicate_recent_folder_names_get_their_parent_as_a_tiebreak() {
        let paths = vec![
            "/Users/x/work/docs".to_string(),
            "/Users/x/personal/docs".to_string(),
            "/Users/x/specs".to_string(),
        ];
        assert_eq!(
            recent_labels(&paths),
            vec!["docs — work", "docs — personal", "specs"]
        );
    }

    #[test]
    fn quick_open_stops_at_its_cap() {
        let t = TempDir::new();
        for i in 0..30 {
            t.write(&format!("n{i:02}.md"), "x");
        }
        let all = list_all_capped(&t.0.to_string_lossy(), 10);
        assert_eq!(all.len(), 10);
        let uncapped = list_all_capped(&t.0.to_string_lossy(), 1000);
        assert_eq!(uncapped.len(), 30);
    }

    // ----------------------------------------------------------- exit flow

    #[test]
    fn the_exit_backstop_only_fires_for_a_silent_current_attempt() {
        // Webview never answered: force-quit is correct.
        assert!(backstop_fires(1, 1, false));
        // Webview acked: it owns the flow now, no wall clock may cut it short.
        assert!(!backstop_fires(1, 1, true));
        // A newer quit attempt superseded this backstop: stand down.
        assert!(!backstop_fires(1, 2, false));
    }

    // -------------------------------------------------- write-path hardening

    #[test]
    fn concurrent_saves_never_publish_a_torn_file() {
        // Two writers hammering one path: with a shared temp name one rename
        // can publish the other's half-written bytes. Unique temp names make
        // every observable content a complete write from one side.
        let t = TempDir::new();
        let path = t.s("note.md");
        run(write_file(path.clone(), "seed".into(), None)).unwrap();
        let a_body = "A".repeat(64 * 1024);
        let b_body = "B".repeat(64 * 1024);
        let spawn = |body: String, path: String| {
            std::thread::spawn(move || {
                for _ in 0..20 {
                    let _ = run(write_file(path.clone(), body.clone(), None));
                }
            })
        };
        let a = spawn(a_body.clone(), path.clone());
        let b = spawn(b_body.clone(), path.clone());
        a.join().unwrap();
        b.join().unwrap();
        let final_content = fs::read_to_string(&path).unwrap();
        assert!(
            final_content == a_body || final_content == b_body,
            "file holds a torn mix of both writers"
        );
        assert_eq!(names(t.path()), vec!["note.md"], "no stray temp files");
    }

    #[cfg(unix)]
    #[test]
    fn saving_through_a_symlink_updates_the_target_and_keeps_the_link() {
        let t = TempDir::new();
        let real = t.write("real.md", "old");
        std::os::unix::fs::symlink(&real, t.path().join("link.md")).unwrap();

        run(write_file(t.s("link.md"), "new".into(), None)).unwrap();

        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
        let meta = fs::symlink_metadata(t.path().join("link.md")).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "the link was replaced by a regular file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn duplicating_a_folder_with_symlinks_copies_links_as_links() {
        let t = TempDir::new();
        fs::create_dir_all(t.path().join("folder")).unwrap();
        t.write("folder/a.md", "a");
        std::os::unix::fs::symlink(t.path().join("folder/a.md"), t.path().join("folder/ln.md"))
            .unwrap();

        let copy = run(duplicate_path(t.s("folder"))).unwrap();

        assert_eq!(
            fs::read_to_string(Path::new(&copy).join("a.md")).unwrap(),
            "a"
        );
        let meta = fs::symlink_metadata(Path::new(&copy).join("ln.md")).unwrap();
        assert!(meta.file_type().is_symlink());
    }

    // -------------------------------------------------- git path literalness

    #[test]
    fn discard_restores_a_committed_file_whose_name_is_a_glob_pattern() {
        // "[draft] plan.md": as a git pathspec, [draft] is a character class
        // that matches nothing in HEAD — so without literal pathspecs the file
        // reads as never-committed and "discard" trashes the whole document.
        let t = TempDir::new();
        let sh = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .current_dir(t.path())
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        };
        sh(&["init", "--quiet", "-b", "main"]);
        sh(&["config", "user.email", "t@example.com"]);
        sh(&["config", "user.name", "t"]);
        let path = t.write("[draft] plan.md", "committed\n");
        sh(&["add", "-A"]);
        sh(&["commit", "--quiet", "-m", "init"]);
        fs::write(&path, "edited\n").unwrap();

        assert_eq!(run(git_discard_kind(path.clone())), Ok("restore".into()));
        assert_eq!(run(git_discard(path.clone())), Ok("restored".into()));
        assert_eq!(fs::read_to_string(&path).unwrap(), "committed\n");
    }

    #[test]
    fn discard_kind_tells_the_truth_about_a_renamed_file() {
        // The porcelain letter says "renamed" (looks committed), but the new
        // path is not in HEAD — discard will trash it, and the UI must be able
        // to say so before the user agrees.
        let t = TempDir::new();
        let sh = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .current_dir(t.path())
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            assert!(ok, "git {args:?} failed");
        };
        sh(&["init", "--quiet", "-b", "main"]);
        sh(&["config", "user.email", "t@example.com"]);
        sh(&["config", "user.name", "t"]);
        let old = t.write("old.md", "body\n");
        sh(&["add", "-A"]);
        sh(&["commit", "--quiet", "-m", "init"]);
        sh(&["mv", "old.md", "new.md"]);

        assert_eq!(run(git_discard_kind(t.s("new.md"))), Ok("trash".into()));
        assert_eq!(run(git_discard_kind(old)), Ok("restore".into()));
    }
}
