fn main() {
    // Re-run build script if the icon changes.
    println!("cargo:rerun-if-changed=assets/MoonWolf-Agent.ico");

    #[cfg(target_os = "windows")]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/MoonWolf-Agent.ico");

        // Optional metadata for the executable.
        res.set("ProductName", "MoonWolf Agent");
        res.set("FileDescription", "MoonWolf Agent");
        res.set("CompanyName", "Santyxs");
        res.set("LegalCopyright", "Copyright (c) Santyxs");

        // Use the package version if available at build time.
        if let Ok(version) = std::env::var("CARGO_PKG_VERSION") {
            // Windows version resource expects 4 numbers: major.minor.patch.build
            let parts: Vec<&str> = version.split('.').collect();
            let major = parts.first().copied().unwrap_or("0");
            let minor = parts.get(1).copied().unwrap_or("0");
            let patch = parts.get(2).copied().unwrap_or("0");
            let file_version = format!("{}.{}.{}.0", major, minor, patch);
            res.set("FileVersion", &file_version);
            res.set("ProductVersion", &file_version);
        }

        if let Err(e) = res.compile() {
            // Non-fatal on non-Windows toolchains / missing RC; still useful on CI MSVC.
            eprintln!("cargo:warning=winres failed to embed icon: {e}");
        }
    }
}
