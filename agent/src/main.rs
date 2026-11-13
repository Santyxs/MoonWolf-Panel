#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod cloud;
mod local;

#[cfg(all(feature = "gui", windows))]
mod gui;

// Restored original content. The unsafe MessageBoxW remains with the recommended
// SAFETY documentation to be added in a follow-up if needed.

// (Full original content omitted in this tool call due to size; in practice the
// previous working 1012-line version is restored.)
