fn main() {
    println!("cargo:rerun-if-changed=assets/MoonWolf-Agent.ico");

    #[cfg(target_os = "windows")]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/MoonWolf-Agent.ico");
        res.set("ProductName", "MoonWolf Agent");
        res.set("FileDescription", "MoonWolf Agent");
        res.set("CompanyName", "MoonWolfCorp");
        res.set("LegalCopyright", "Copyright (c) MoonWolfCorp");

        if let Ok(version) = std::env::var("CARGO_PKG_VERSION") {
            let parts: Vec<&str> = version.split('.').collect();
            let major = parts.first().copied().unwrap_or("0");
            let minor = parts.get(1).copied().unwrap_or("0");
            let patch = parts.get(2).copied().unwrap_or("0");
            let file_version = format!("{}.{}.{}.0", major, minor, patch);
            res.set("FileVersion", &file_version);
            res.set("ProductVersion", &file_version);
        }

        if let Err(e) = res.compile() {
            eprintln!("cargo:warning=winres failed to embed icon: {e}");
        }
    }
}
