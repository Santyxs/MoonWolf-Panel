//! Auto-actualización y reinicio del Agent en Windows.

use std::path::PathBuf;
use tracing::info;

use crate::AgentConfig;

#[cfg(windows)]
pub async fn apply_update(current_exe: &PathBuf, new_exe: &PathBuf) -> anyhow::Result<()> {
    use std::os::windows::process::CommandExt;

    let current_exe = current_exe
        .canonicalize()
        .unwrap_or_else(|_| current_exe.clone());
    let new_exe = new_exe.canonicalize().unwrap_or_else(|_| new_exe.clone());

    let old = current_exe.with_extension("exe.old");
    let _ = tokio::fs::remove_file(&old).await;

    tokio::fs::rename(&current_exe, &old).await.map_err(|e| {
        anyhow::anyhow!("No se pudo renombrar el ejecutable actual (¿en uso?): {e}")
    })?;
    tokio::fs::copy(&new_exe, &current_exe).await.map_err(|e| {
        let _ = std::fs::rename(&old, &current_exe);
        anyhow::anyhow!("No se pudo copiar el nuevo ejecutable: {e}")
    })?;

    let pid = std::process::id();
    let exe_str = current_exe.to_string_lossy().replace('"', "");

    let dir = AgentConfig::config_dir().join("updates");
    tokio::fs::create_dir_all(&dir).await?;
    let bat_path = dir.join("restart-after-update.bat");
    let bat = format!(
        "@echo off\r\n\
         setlocal\r\n\
         set PID={pid}\r\n\
         set EXE={exe}\r\n\
         :wait\r\n\
         tasklist /FI \"PID eq %PID%\" 2>NUL | findstr /I \"%PID%\" >NUL\r\n\
         if not errorlevel 1 (\r\n\
           timeout /t 1 /nobreak >NUL\r\n\
           goto wait\r\n\
         )\r\n\
         timeout /t 1 /nobreak >NUL\r\n\
         start \"\" \"%EXE%\"\r\n\
         del \"%~f0\" >NUL 2>&1\r\n\
         endlocal\r\n",
        pid = pid,
        exe = exe_str,
    );
    tokio::fs::write(&bat_path, bat).await?;

    // Lanzar el .bat desacoplado: start crea proceso independiente del Agent
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let bat_str = bat_path.to_string_lossy().replace('"', "");
    let status = std::process::Command::new("cmd.exe")
        .args(["/C", "start", "", "/MIN", &bat_str])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    if let Err(e) = status {
        anyhow::bail!("No se pudo lanzar el reinicio post-update: {e}");
    }

    info!("Actualización lista; reinicio programado tras cerrar PID {pid}");
    Ok(())
}
