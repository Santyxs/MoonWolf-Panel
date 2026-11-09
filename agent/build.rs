fn main() {
    println!("cargo:rerun-if-changed=assets/MoonWolf-Agent.ico");
    println!("cargo:rerun-if-changed=ui/main.slint");
    println!("cargo:rerun-if-env-changed=MOONWOLF_AGENT_VERSION");

    slint_build::compile("ui/main.slint").expect("No se pudo compilar la interfaz Slint");

    #[cfg(target_os = "windows")]
    {
        let version = std::env::var("MOONWOLF_AGENT_VERSION")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        let parts: Vec<&str> = version.trim_start_matches('v').split('.').collect();
        let major = parts.first().copied().unwrap_or("0");
        let minor = parts.get(1).copied().unwrap_or("0");
        let patch = parts.get(2).copied().unwrap_or("0");
        let build = parts.get(3).copied().unwrap_or("0");
        let file_version = format!("{major}.{minor}.{patch}.{build}");
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/MoonWolf-Agent.ico");
        res.set("ProductName", "MoonWolf Agent");
        res.set("FileDescription", "MoonWolf Agent");
        res.set("CompanyName", "MoonWolfCorp");
        res.set("LegalCopyright", "Copyright (c) MoonWolfCorp");
        res.set("FileVersion", &file_version);
        res.set("ProductVersion", &file_version);
        if let Err(e) = res.compile() {
            eprintln!("cargo:warning=winres failed to embed icon: {e}");
        }
    }
}
