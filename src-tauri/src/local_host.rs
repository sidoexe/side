//! Keeps the host installed on this computer (`~/.side-host`, the service the
//! iPhone and browser apps reach) on this desktop's release, the way
//! `useHostAutoUpdate` does for SSH machines: checked at launch and every few
//! minutes, and only while no turn runs there, since updating restarts it.

use crate::remote_ssh::upgrade_script;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CHECK_EVERY: Duration = Duration::from_secs(5 * 60);
const UPGRADE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DEFAULT_PORT: u16 = 3775;

#[derive(Debug, PartialEq)]
enum Outcome {
    /// No host here, or it already runs this release.
    Current,
    Busy,
    Updated,
    Failed(String),
}

pub fn init() {
    let Some(home) = crate::dirs_home() else {
        return;
    };
    let base = Path::new(&home).join(".side-host");
    std::thread::spawn(move || loop {
        match check(&home, &base, env!("CARGO_PKG_VERSION")) {
            Outcome::Busy => {}
            Outcome::Updated => eprintln!("[local-host] updated to {}", env!("CARGO_PKG_VERSION")),
            // Retried on the next launch, not every few minutes.
            Outcome::Failed(error) => {
                eprintln!("[local-host] update failed: {error}");
                return;
            }
            Outcome::Current => return,
        }
        std::thread::sleep(CHECK_EVERY);
    });
}

fn check(home: &str, base: &Path, app_version: &str) -> Outcome {
    let entry = base.join("bin/side-host");
    if !entry.is_file() {
        return Outcome::Current;
    }
    let installed = Command::new(&entry)
        .arg("--version")
        .env("HOME", home)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    if !host_is_older(installed.as_deref(), app_version) {
        return Outcome::Current;
    }
    match running_turn(&base.join("host.db")) {
        Ok(false) => {}
        Ok(true) => return Outcome::Busy,
        Err(error) => return Outcome::Failed(error),
    }
    match upgrade(home, port(base)) {
        Ok(()) => Outcome::Updated,
        Err(error) => Outcome::Failed(error),
    }
}

/// Mirrors `hostIsOlder`: a host that does not say is older; a development
/// build with no comparable version is never called older.
fn host_is_older(host: Option<&str>, app: &str) -> bool {
    let Some(app) = parse(app) else {
        return false;
    };
    match host {
        None => true,
        Some(host) => parse(host).is_some_and(|host| host < app),
    }
}

fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim().splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?;
    let digits = patch
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(patch.len());
    Some((major, minor, patch[..digits].parse().ok()?))
}

/// The host records each turn's status in its database as it runs, so this
/// holds for any host release, including ones from before this check.
fn running_turn(db: &Path) -> Result<bool, String> {
    if !db.is_file() {
        return Ok(false);
    }
    let connection =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE json_extract(snapshot, '$.status') = 'running')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
}

/// The port the service listens on, kept across the reinstall.
fn port(base: &Path) -> u16 {
    std::fs::read_to_string(base.join("running.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|state| state.get("port")?.as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT)
}

fn upgrade(home: &str, port: u16) -> Result<(), String> {
    let mut child = Command::new("/bin/sh")
        .arg("-s")
        .env("HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(upgrade_script(port).as_bytes())
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => break,
            None if started.elapsed() > UPGRADE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(4000)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_older_release_is_older() {
        assert!(host_is_older(Some("0.29.1"), "0.30.0"));
        assert!(host_is_older(Some("0.9.9"), "0.10.0"));
        assert!(host_is_older(None, "0.30.0"));
        assert!(!host_is_older(Some("0.30.0"), "0.30.0"));
        assert!(!host_is_older(Some("0.31.0"), "0.30.0"));
        assert!(!host_is_older(Some("dev"), "0.30.0"));
        assert!(!host_is_older(Some("0.29.1"), "dev"));
        assert!(host_is_older(Some("0.29.1-beta.1"), "0.29.2"));
    }

    #[test]
    fn a_running_turn_in_the_database_waits() {
        let dir = std::env::temp_dir().join(format!("side-local-host-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("host.db");
        let _ = std::fs::remove_file(&db);
        assert_eq!(running_turn(&db), Ok(false));
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, snapshot TEXT);
                 INSERT INTO sessions VALUES ('a', 'p', '{\"status\":\"idle\"}');",
            )
            .unwrap();
        assert_eq!(running_turn(&db), Ok(false));
        connection
            .execute(
                "INSERT INTO sessions VALUES ('b', 'p', '{\"status\":\"running\"}')",
                [],
            )
            .unwrap();
        assert_eq!(running_turn(&db), Ok(true));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_host_installed_is_left_alone() {
        let dir = std::env::temp_dir().join("side-local-host-none");
        assert_eq!(check("/nonexistent", &dir, "0.30.0"), Outcome::Current);
    }
}
