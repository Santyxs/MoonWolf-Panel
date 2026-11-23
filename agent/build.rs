use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    println!("cargo:rerun-if-changed=../assets/icon.ico");
    println!("cargo:rerun-if-changed=ui/main.slint");
    println!("cargo:rerun-if-env-changed=MOONWOLF_AGENT_VERSION");
    println!("cargo:rerun-if-env-changed=RC");

    slint_build::compile("ui/main.slint").expect("No se pudo compilar la interfaz Slint");

    let is_windows_msvc = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_windows_msvc {
        embed_windows_resources();
    }
}

fn embed_windows_resources() {
    let version = env::var("MOONWOLF_AGENT_VERSION")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let mut nums = version
        .trim_start_matches('v')
        .split('.')
        .map(|p| p.parse::<u16>().unwrap_or(0));
    let (major, minor, patch, build) = (
        nums.next().unwrap_or(0),
        nums.next().unwrap_or(0),
        nums.next().unwrap_or(0),
        nums.next().unwrap_or(0),
    );
    let file_version = format!("{major}.{minor}.{patch}.{build}");

    let icon = match fs::canonicalize("../assets/icon.ico") {
        Ok(p) => p.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/"),
        Err(e) => {
            println!("cargo:warning=no se encontró el icono: {e}");
            return;
        }
    };

    let rc_text = format!(
        r#"1 ICON "{icon}"

1 VERSIONINFO
FILEVERSION {major},{minor},{patch},{build}
PRODUCTVERSION {major},{minor},{patch},{build}
FILEOS 0x40004
FILETYPE 0x1
{{
    BLOCK "StringFileInfo"
    {{
        BLOCK "040904B0"
        {{
            VALUE "ProductName", "MoonWolf Agent"
            VALUE "FileDescription", "MoonWolf Agent"
            VALUE "CompanyName", "MoonWolfCorp"
            VALUE "LegalCopyright", "Copyright (c) MoonWolfCorp"
            VALUE "FileVersion", "{file_version}"
            VALUE "ProductVersion", "{file_version}"
        }}
    }}
    BLOCK "VarFileInfo"
    {{
        VALUE "Translation", 0x409, 1200
    }}
}}
"#
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let rc_path = out_dir.join("moonwolf-agent.rc");
    let res_path = out_dir.join("moonwolf-agent.res");
    if let Err(e) = fs::write(&rc_path, rc_text) {
        println!("cargo:warning=no se pudo escribir el .rc: {e}");
        return;
    }

    let Some(rc_exe) = find_rc_exe() else {
        println!("cargo:warning=rc.exe no encontrado; el .exe no tendrá icono ni versión");
        return;
    };

    let status = Command::new(&rc_exe)
        .arg("/nologo")
        .arg("/fo")
        .arg(&res_path)
        .arg(&rc_path)
        .status();

    match status {
        Ok(s) if s.success() && res_path.is_file() => {
            println!("cargo:rustc-link-arg-bins={}", res_path.display());
        }
        other => println!("cargo:warning=rc.exe falló ({other:?}); el .exe no tendrá icono ni versión"),
    }
}

fn find_rc_exe() -> Option<PathBuf> {

    if let Some(p) = env::var_os("RC").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }

    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            let candidate = dir.join("rc.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let pf86 = env::var_os("ProgramFiles(x86)").or_else(|| env::var_os("ProgramFiles"))?;
    let bin = Path::new(&pf86).join("Windows Kits").join("10").join("bin");
    let mut versions: Vec<PathBuf> = fs::read_dir(&bin)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    versions.sort();
    versions.reverse();
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86") => "x86",
        _ => "x64",
    };
    versions
        .into_iter()
        .map(|v| v.join(arch).join("rc.exe"))
        .find(|p| p.is_file())
}
