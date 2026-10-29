use std::env;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let vendor = manifest.join("vendor").join("phonon25");
    let csrc = vendor.join("csrc");
    let target = env::var("TARGET").expect("TARGET");

    let mut build = cc::Build::new();
    build
        .include(&csrc)
        .warnings(false)
        .opt_level(3)
        .define("P25_NO_MAIN", None);

    // The engine library. main.c is the upstream CLI and is intentionally not
    // linked; bench_gemm.c is a benchmark. bridge.c adds the two tiny symbols
    // Rust needs (p25_free, p25_set_verbose).
    for name in [
        "blas",
        "threadpool",
        "tensor_ops",
        "encoder",
        "decoder",
        "mel",
        "weights",
        "tokens",
        "wav",
        "resample",
        "segment",
        "engine",
        "json",
        "bridge",
    ] {
        let path = csrc.join(format!("{name}.c"));
        println!("cargo:rerun-if-changed={}", path.display());
        build.file(path);
    }

    if target.contains("windows") {
        build
            .include(vendor.join("win32").join("include"))
            .file(vendor.join("win32").join("p25_compat.c"))
            .static_crt(true)
            .define("_CRT_SECURE_NO_WARNINGS", None)
            .define("CLOCK_MONOTONIC", Some("0"))
            // MSVC does not define the GCC feature macros the AVX2 kernels use.
            .define("__AVX2__", None)
            .define("__FMA__", None)
            .flag_if_supported("/experimental:c11atomics")
            .flag_if_supported("/std:c11")
            .flag_if_supported("/arch:AVX2")
            .flag_if_supported("/fp:fast");
        println!(
            "cargo:rerun-if-changed={}",
            vendor.join("win32").join("p25_compat.c").display()
        );
        println!(
            "cargo:rerun-if-changed={}",
            vendor.join("win32").join("p25_win32.h").display()
        );
    } else {
        build
            .flag_if_supported("-std=c11")
            .flag_if_supported("-ffast-math")
            .flag_if_supported("-fno-finite-math-only")
            .flag_if_supported("-pthread");
        if target.contains("x86_64") {
            build.flag_if_supported("-mavx2").flag_if_supported("-mfma");
        }
        if target.contains("aarch64") && target.contains("apple") {
            build.flag_if_supported("-mcpu=apple-m1");
        }
        println!("cargo:rustc-link-lib=m");
        if target.contains("linux") {
            println!("cargo:rustc-link-lib=pthread");
        }
    }

    build.compile("phonon25");
}
