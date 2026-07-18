fn main() {
    tauri_build::build();

    // Copy WebView2Loader.dll next to the exe for NSIS installer
    let dll_src = std::path::Path::new("resources/WebView2Loader.dll");
    let target_dir = std::path::Path::new(
        &std::env::var("CARGO_MANIFEST_DIR").unwrap()
    ).join("target").join("release");
    let dst = target_dir.join("WebView2Loader.dll");
    if dll_src.exists() {
        std::fs::create_dir_all(&target_dir).ok();
        std::fs::copy(dll_src, &dst).ok();
        println!("cargo:warning=WebView2Loader.dll copied to {}", dst.display());
    }
}
