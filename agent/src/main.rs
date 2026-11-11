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

static UPDATE_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn home_dir() -> Option<std::path::PathBuf> {
    if let Some(h) = std::env::var_os("HOME") {
        return Some(std::path::PathBuf::from(h));
    }
    if let Some(h) = std::env::var_os("USERPROFILE") {
        return Some(std::path::PathBuf::from(h));
    }
    None
}
