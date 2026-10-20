//! sIDE has its own bundle identifier, so it can be installed beside
//! MonoCode. On its first launch it starts from a copy of MonoCode's data:
//! the app data folder (sessions, checkpoints, connections) and
//! the WebKit folder holding the window's localStorage. Nothing is moved:
//! MonoCode keeps working on its own copy.
//!
//! Each folder is copied into a temporary sibling and renamed into place, so
//! an interrupted copy is retried on the next launch instead of leaving half
//! a folder that would read as already migrated. SQLite databases are copied
//! with `VACUUM INTO`, which gives a consistent file even while MonoCode is
//! running and writing to its own.
use std::path::{Path, PathBuf};

pub const MONOCODE_IDENTIFIER: &str = "com.monocode.desktop";
/// sIDE's own, as in tauri.conf.json.
pub const IDENTIFIER: &str = "dev.sidoexe.side";
const MARKER: &str = "migrated-from-monocode.json";

/// Copies MonoCode's data under `library` (`~/Library`) for `identifier`,
/// once. Returns whether anything was copied.
pub fn adopt_monocode_data(library: &Path, identifier: &str) -> Result<bool, String> {
    if identifier == MONOCODE_IDENTIFIER {
        return Ok(false);
    }
    let support = library.join("Application Support");
    let copied = adopt(
        &support.join(MONOCODE_IDENTIFIER),
        &support.join(identifier),
    )?;
    let webkit = library.join("WebKit");
    adopt(&webkit.join(MONOCODE_IDENTIFIER), &webkit.join(identifier))?;
    if copied {
        let note = format!(
            "{{\"from\":\"{MONOCODE_IDENTIFIER}\",\"at\":{}}}\n",
            crate::session_store::now_millis()
        );
        let _ = std::fs::write(support.join(identifier).join(MARKER), note);
    }
    Ok(copied)
}

/// `from` into `to`, when `to` does not exist yet.
fn adopt(from: &Path, to: &Path) -> Result<bool, String> {
    if to.exists() || !from.is_dir() {
        return Ok(false);
    }
    let parent = to.parent().ok_or("Missing data folder parent")?;
    let staging: PathBuf = parent.join(format!(
        ".{}.migrating",
        to.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("data")
    ));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    }
    copy_tree(from, &staging)?;
    std::fs::rename(&staging, to).map_err(|e| format!("{}: {e}", to.display()))?;
    Ok(true)
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_symlink() {
            // A linked folder stays a link to the same place.
            let link = std::fs::read_link(&source).map_err(|e| e.to_string())?;
            symlink(&link, &target)?;
        } else if kind.is_dir() {
            copy_tree(&source, &target)?;
        } else if name.ends_with(".db") {
            copy_database(&source, &target)?;
        } else if name.ends_with(".db-wal") || name.ends_with(".db-shm") {
            // Folded into the database copy above.
        } else {
            std::fs::copy(&source, &target).map_err(|e| format!("{}: {e}", source.display()))?;
        }
    }
    Ok(())
}

fn copy_database(from: &Path, to: &Path) -> Result<(), String> {
    let conn = rusqlite::Connection::open_with_flags(
        from,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("{}: {e}", from.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute("VACUUM INTO ?1", [to.to_string_lossy().as_ref()])
        .map_err(|e| format!("{}: {e}", from.display()))?;
    Ok(())
}

#[cfg(unix)]
fn symlink(link: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(link, target).map_err(|e| format!("{}: {e}", target.display()))
}

/// Colleagues were removed from sIDE. What they kept in the app data folder
/// goes with them: their files, their private Codex stores and the menu bar
/// icon's setting. A folder that is a link only loses the link, never what it
/// points at.
pub fn remove_colleague_data(data: &Path) {
    for name in ["monos", "agents", "codex-monos", "menu-bar-icon-hidden"] {
        let path = data.join(name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let removed = if meta.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(error) = removed {
            eprintln!("Could not remove {}: {error}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> PathBuf {
        let root = std::env::temp_dir().join(format!("side-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn seed(library: &Path) -> PathBuf {
        let old = library
            .join("Application Support")
            .join(MONOCODE_IDENTIFIER);
        std::fs::create_dir_all(old.join("checkpoints")).unwrap();
        std::fs::write(old.join("remote-machines.json"), "[]").unwrap();
        std::fs::write(old.join("checkpoints").join("a"), "x").unwrap();
        let conn = rusqlite::Connection::open(old.join("monocode.db")).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('kept');",
        )
        .unwrap();
        // Left open: the copy must still see the row that sits in the WAL.
        std::mem::forget(conn);
        let webkit = library
            .join("WebKit")
            .join(MONOCODE_IDENTIFIER)
            .join("WebsiteData");
        std::fs::create_dir_all(&webkit).unwrap();
        std::fs::write(webkit.join("salt"), "s").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/tmp", old.join("linked")).unwrap();
        old
    }

    #[test]
    fn copies_monocode_data_once_and_leaves_it_in_place() {
        let library = library();
        let old = seed(&library);
        assert!(adopt_monocode_data(&library, "dev.sidoexe.side").unwrap());
        let new = library.join("Application Support").join("dev.sidoexe.side");
        assert_eq!(
            std::fs::read_to_string(new.join("remote-machines.json")).unwrap(),
            "[]"
        );
        assert_eq!(
            std::fs::read_to_string(new.join("checkpoints").join("a")).unwrap(),
            "x"
        );
        let copy = rusqlite::Connection::open(new.join("monocode.db")).unwrap();
        let value: String = copy
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "kept");
        assert!(!new.join("monocode.db-wal").exists());
        assert!(new.join(MARKER).is_file());
        #[cfg(unix)]
        assert_eq!(
            std::fs::read_link(new.join("linked")).unwrap(),
            PathBuf::from("/tmp")
        );
        assert!(library
            .join("WebKit/dev.sidoexe.side/WebsiteData/salt")
            .is_file());
        assert!(old.join("remote-machines.json").is_file());
        // Already sIDE's: never copied over again.
        std::fs::write(old.join("remote-machines.json"), "[changed]").unwrap();
        assert!(!adopt_monocode_data(&library, "dev.sidoexe.side").unwrap());
        assert_eq!(
            std::fs::read_to_string(new.join("remote-machines.json")).unwrap(),
            "[]"
        );
        std::fs::remove_dir_all(library).unwrap();
    }

    #[test]
    fn matches_the_bundle_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }

    #[test]
    fn retries_an_interrupted_copy_and_ignores_a_missing_monocode() {
        let library = library();
        assert!(!adopt_monocode_data(&library, "dev.sidoexe.side").unwrap());
        seed(&library);
        let staging = library
            .join("Application Support")
            .join(".dev.sidoexe.side.migrating");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("partial"), "").unwrap();
        assert!(adopt_monocode_data(&library, "dev.sidoexe.side").unwrap());
        let new = library.join("Application Support").join("dev.sidoexe.side");
        assert!(!new.join("partial").exists());
        assert!(!staging.exists());
        assert!(!adopt_monocode_data(&library, MONOCODE_IDENTIFIER).unwrap());
        std::fs::remove_dir_all(library).unwrap();
    }

    #[test]
    fn removes_colleague_data_without_following_links() {
        let data = library();
        std::fs::create_dir_all(data.join("monos/e1")).unwrap();
        std::fs::write(data.join("monos/e1/SOUL.md"), "soul").unwrap();
        std::fs::create_dir_all(data.join("codex-monos")).unwrap();
        let kept = library();
        std::fs::write(kept.join("note"), "n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&kept, data.join("agents")).unwrap();
        std::fs::write(data.join("monocode.db"), "db").unwrap();
        remove_colleague_data(&data);
        assert!(!data.join("monos").exists());
        assert!(!data.join("codex-monos").exists());
        assert!(!data.join("agents").exists());
        assert!(kept.join("note").is_file());
        assert!(data.join("monocode.db").is_file());
    }
}
