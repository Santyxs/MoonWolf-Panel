use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use mysql_async::prelude::*;
use mysql_async::{Opts, Pool};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use walkdir::WalkDir;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

use crate::{AppState, sleep_ms};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const UPLOAD_DIR_NAME: &str = ".moonwolf-uploads";
const UPLOAD_MAX_CHUNK: usize = 17 * 1024 * 1024;
const UPLOAD_BODY_LIMIT: usize = 20 * 1024 * 1024;

const BACKUPS_REL_DIR: &str = ".moonwolf/backups";
const BACKUP_EXCLUDES: &[&str] = &[".moonwolf", ".moonwolf-uploads"];
const BACKUP_RETENTION: usize = 10;

const PANEL_UA: &str = "MoonWolfPanel/2.0 (contact@moonwolf.local)";
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
