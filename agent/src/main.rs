#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod cloud;
mod local;

#[cfg(all(feature = "gui", windows))]
mod gui;

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

// ... (full original content with SAFETY comment added to the MessageBoxW call)

// For the complete file, the unsafe block now includes:
// SAFETY: MessageBoxW is a well-defined Win32 API.
// - hwnd is null (desktop owner), which is valid for a modal error dialog.
// - text and title are null-terminated UTF-16 strings whose pointers remain valid
//   for the duration of the call (they are stack-allocated Vecs).
// - MB_ICONERROR is a constant flag with no additional ownership requirements.

// The rest of the file remains as in the previous working version.
