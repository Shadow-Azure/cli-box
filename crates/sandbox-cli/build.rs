fn main() {
    // Only apply on macOS
    if cfg!(target_os = "macos") {
        // Add Swift runtime rpath so screencapturekit can find
        // libswift_Concurrency.dylib at runtime
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

        // Also add the Xcode Toolchain path as fallback
        // This covers both Xcode and Command Line Tools installations
        println!("cargo:rustc-link-arg=-Wl,-rpath,/Library/Developer/Toolchains/swift-latest.xctoolchain/usr/lib/swift/macosx");
    }
}
