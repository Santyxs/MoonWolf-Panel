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
use sqlx::Row;
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
