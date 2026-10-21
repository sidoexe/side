//! Caffeine mode: keeps this computer from idle-sleeping while it is on, so
//! long agent turns keep running with the lid open and nobody at the desk.
//! The blocker is a child process (`caffeinate` on macOS, `systemd-inhibit`
//! on Linux); stopping it, or this app exiting, lets the machine sleep again.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

static BLOCKER: Mutex<Option<Child>> = Mutex::new(None);

#[cfg(target_os = "macos")]
fn blocker() -> Command {
    // `-i` holds off idle sleep, `-w` ends it with this app even on a crash.
    let mut command = Command::new("/usr/bin/caffeinate");
    command.args(["-i", "-w", &std::process::id().to_string()]);
    command
}

#[cfg(target_os = "linux")]
fn blocker() -> Command {
    let mut command = Command::new("systemd-inhibit");
    command.args([
        "--what=idle:sleep",
        "--who=sIDE",
        "--why=Caffeine mode",
        "--mode=block",
        "sleep",
        "infinity",
    ]);
    command
}

fn running(slot: &mut Option<Child>) -> bool {
    match slot {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            _ => {
                *slot = None;
                false
            }
        },
        None => false,
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn start(slot: &mut Option<Child>) -> Result<(), String> {
    let mut child = blocker()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot keep this computer awake: {error}"))?;
    // A refused inhibitor exits at once; report it instead of showing it on.
    std::thread::sleep(Duration::from_millis(200));
    if let Ok(Some(_)) = child.try_wait() {
        let mut reason = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            use std::io::Read;
            let _ = stderr.read_to_string(&mut reason);
        }
        let reason = reason.trim();
        return Err(if reason.is_empty() {
            "Cannot keep this computer awake".into()
        } else {
            format!("Cannot keep this computer awake: {reason}")
        });
    }
    // Never read again; dropping it keeps a full pipe from blocking the child.
    drop(child.stderr.take());
    *slot = Some(child);
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn start(_slot: &mut Option<Child>) -> Result<(), String> {
    Err("Caffeine mode is not available on this system".into())
}

fn stop_in(slot: &mut Option<Child>) {
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Whether this computer is being kept awake.
#[tauri::command]
pub fn caffeine_status() -> bool {
    running(&mut BLOCKER.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Turns caffeine mode on or off; answers the resulting state.
#[tauri::command]
pub fn caffeine_set(on: bool) -> Result<bool, String> {
    let mut slot = BLOCKER.lock().unwrap_or_else(|e| e.into_inner());
    if on {
        if !running(&mut slot) {
            start(&mut slot)?;
        }
    } else {
        stop_in(&mut slot);
    }
    Ok(running(&mut slot))
}

/// Lets the computer sleep again, as this app exits.
pub fn stop() {
    stop_in(&mut BLOCKER.lock().unwrap_or_else(|e| e.into_inner()));
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn turns_on_and_off() {
        assert!(caffeine_set(true).unwrap());
        assert!(caffeine_status());
        assert!(!caffeine_set(false).unwrap());
        assert!(!caffeine_status());
    }
}
