// GUI-subsystem app in release (no console window). DO NOT REMOVE.
//
// We deliberately stay GUI-subsystem. The `EnforceRedirectionTrust` junction
// breakage (scoop/winget shims) is NOT caused by the subsystem — it's inherited
// from `msiexec` when the installer auto-launches the app. Verified via
// `Get-NtProcessMitigations`: a GUI build launched from Explorer has the
// mitigation OFF. The fix is to disable installer auto-launch (WiX template),
// not to become a console app. See win_api in lib.rs for the full story.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nugram_lib::run()
}
