use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    ensure_desktop_artifacts();
    tauri_build::build();
}

/// `tauri-build` resolves `bundle.externalBin` and `bundle.resources` at
/// compile time — including `tauri dev` and `cargo check`, which never run
/// `beforeBuildCommand`. Those artifacts are gitignored, so a fresh checkout
/// would fail here unless we stage them first.
fn ensure_desktop_artifacts() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let target = env::var("TARGET").unwrap_or_else(|_| env::var("HOST").expect("HOST"));
    let suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let sidecar = manifest_dir
        .join("binaries")
        .join(format!("node-{target}{suffix}"));
    let resources = manifest_dir.join("resources").join("app");
    let script = manifest_dir
        .parent()
        .expect("src-tauri has a parent")
        .join("scripts")
        .join("prepare-desktop.mjs");

    println!("cargo:rerun-if-changed={}", sidecar.display());
    println!("cargo:rerun-if-changed={}", resources.display());
    println!("cargo:rerun-if-changed={}", script.display());

    if sidecar.is_file() && resources.is_dir() {
        return;
    }

    run_prepare(&manifest_dir, &script, &target);

    if !sidecar.is_file() {
        panic!(
            "prepare-desktop finished but {} is still missing",
            sidecar.display()
        );
    }
}

fn run_prepare(manifest_dir: &Path, script: &Path, target: &str) {
    if !script.is_file() {
        panic!(
            "desktop sidecar is missing and {} does not exist. \
             Run: node scripts/prepare-desktop.mjs --skip-next",
            script.display()
        );
    }

    let repo_root = manifest_dir.parent().expect("src-tauri has a parent");
    let status = node_command()
        .arg(script)
        .arg("--skip-next")
        .arg("--target")
        .arg(target)
        .current_dir(repo_root)
        .status()
        .unwrap_or_else(|err| {
            panic!(
                "failed to spawn `node` to stage the desktop sidecar: {err}\n\
                 Install Node.js (>=20) and ensure it is on PATH, or run:\n\
                 node scripts/prepare-desktop.mjs --skip-next"
            );
        });

    if !status.success() {
        panic!(
            "scripts/prepare-desktop.mjs --skip-next failed ({status}). \
             tauri-build requires `binaries/node-<triple>` even for `tauri dev`."
        );
    }
}

fn node_command() -> Command {
    // Windows shims are often `node.cmd`; CreateProcess does not search PATHEXT.
    if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/C", "node"]);
        cmd
    } else {
        Command::new("node")
    }
}
