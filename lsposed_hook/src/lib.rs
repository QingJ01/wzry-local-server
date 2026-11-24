//! LSPosed JNI payload for the Houdini self-SIGKILL patch.
//!
//! Loaded by `com.wzry.houdinihook.HookEntry` inside `com.tencent.tmgp.sgame`
//! via `System.load`. At that point `libhoudini.so` is already mapped
//! by the native bridge, so the runtime patch at `0x324eef` applies directly.
//!
//! Patch (verified in `reports/houdini_hook_validation_20261124.md`):
//!   - `0x324ee9: 41 83 fd 09`   = `cmp r13d, 9`         (r13d = signo)
//!   - `0x324eed: 75 40`        = `jne 0xaf`            (non-9 -> normal path)
//!   - `0x324eef: bf ba 00 00 00` = `mov edi, 0xba`     (SIGKILL block entry)
//!   - `0x3250b3: 89 d8`        = `mov eax, ebx`        (function tail, ebx=0)
//!
//! Replace the 3 bytes at `0x324eef` with `e9 bf 01 00 00`
//! (`jmp rel32 0x1bf` -> `0x3250b3`) so a guest self-`kill(pid, SIGKILL)`
//! returns 0 without issuing the host syscall. Non-9 signals are untouched.

#![no_std]

use core::ffi::c_void;
use core::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

const TARGET_PACKAGE: &[u8] = b"com.tencent.tmgp.sgame";

/// RVA inside libhoudini.so of the SIGKILL-block entry (`mov edi, 0xba`).
const PATCH_RVA: usize = 0x324eef;

/// Original bytes at `0x324eef` (`mov edi, 0xba` = `bf ba 00 00 00`).
static ORIG_BYTES: [u8; 3] = [0xbf, 0xba, 0x00];

/// Replacement bytes (`jmp rel32 0x1bf` -> `0x3250b3`, the `mov eax,ebx`
/// function tail that returns 0).
static PATCH_BYTES: [u8; 3] = [0xe9, 0xbf, 0x01];

/// Already-patched marker (our own jmp opcode), for idempotent re-entry.
const PATCHED_OPCODE: u8 = 0xe9;

// ------------------------------------------------------------------
// Counters: read back by `counters()` JNI and logcat self-report.
//   [0] hooked (0=not attempted, 1=patched, 2=orig mismatch, 3=no houdini)
//   [1] install attempts
//   [2] bytes-verified mismatches seen
// ------------------------------------------------------------------

static STATE: AtomicUsize = AtomicUsize::new(0);
static INSTALLS: AtomicU64 = AtomicU64::new(0);
static MISMATCHES: AtomicU64 = AtomicU64::new(0);

// ------------------------------------------------------------------
// JNI shim: minimal JNIEnv/CallStaticVoidMethod-free implementation.
// We only need the raw export symbols; Java declares them as native.
// ------------------------------------------------------------------

/// `public static native boolean NativeInstall.install()`
#[no_mangle]
pub extern "C" fn Java_com_wzry_houdinihook_NativeInstall_install(
    _env: *mut c_void,
    _class: *mut c_void,
) -> u8 {
    INSTALLS.fetch_add(1, Ordering::Relaxed);
    // Package filtering is handled by the LSPosed Java side (handleLoadPackage
    // only fires for com.tencent.tmgp.sgame). Reading /proc/self/cmdline inside
    // the hooked app proved unreliable on MuMu (SELinux/binder threads), so the
    // native layer no longer re-checks.
    log_cmdline_probe();
    match unsafe { install_hook() } {
        1 => {
            log(b"houdini selfkill patch applied @0x324eef\0");
            STATE.store(1, Ordering::Release);
            1
        }
        2 => {
            MISMATCHES.fetch_add(1, Ordering::Relaxed);
            log(b"orig bytes mismatch, already patched?\0");
            STATE.store(2, Ordering::Release);
            0
        }
        _ => {
            log(b"houdini base not found\0");
            STATE.store(3, Ordering::Release);
            0
        }
    }
}

/// `public static native int NativeInstall.state()`
/// Returns the hook state (0=not attempted, 1=patched, 2=orig mismatch,
/// 3=no houdini base). Kept as a plain `int` so the Java side needs no
/// array allocation through JNIEnv.
#[no_mangle]
pub extern "C" fn Java_com_wzry_houdinihook_NativeInstall_state(
    _env: *mut c_void,
    _class: *mut c_void,
) -> i32 {
    STATE.load(Ordering::Acquire) as i32
}

// ------------------------------------------------------------------
// /proc/self/comm + cmdline package filter
// ------------------------------------------------------------------

#[allow(dead_code)]
fn is_target_process() -> bool {
    for path in [
        b"/proc/self/cmdline\0".as_ptr() as *const i8,
        b"/proc/self/comm\0".as_ptr() as *const i8,
    ] {
        let mut buf = [0u8; 256];
        let fd = unsafe { libc::open(path, libc::O_RDONLY) };
        if fd < 0 {
            continue;
        }
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut c_void, buf.len() - 1) };
        unsafe { libc::close(fd) };
        if n <= 0 {
            continue;
        }
        let len = (n as usize).min(buf.len() - 1);
        if buf[..len]
            .windows(TARGET_PACKAGE.len())
            .any(|w| w == TARGET_PACKAGE)
        {
            return true;
        }
    }
    false
}

// Log the first bytes of /proc/self/cmdline and /proc/self/comm for
// diagnostics; used to confirm why the package filter was unreliable.
fn log_cmdline_probe() {
    let mut buf = [0u8; 64];
    let fd = unsafe {
        libc::open(
            b"/proc/self/cmdline\0".as_ptr() as *const i8,
            libc::O_RDONLY,
        )
    };
    if fd >= 0 {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut c_void, buf.len() - 1) };
        unsafe { libc::close(fd) };
        if n > 0 {
            let len = (n as usize).min(buf.len() - 1);
            // Sanitize non-printable to '.' so the log line stays clean.
            let mut out = [b'.'; 64];
            for i in 0..len {
                let c = buf[i];
                out[i] = if (0x20..0x7f).contains(&c) { c } else { b'.' };
            }
            let msg = b"cmdline probe: \0";
            let mut line = [0u8; 96];
            line[..msg.len() - 1].copy_from_slice(&msg[..msg.len() - 1]);
            line[msg.len() - 1..msg.len() - 1 + len].copy_from_slice(&out[..len]);
            log(&line[..msg.len() - 1 + len + 1]);
        } else {
            log(b"cmdline probe: read empty\0");
        }
    } else {
        log(b"cmdline probe: open failed\0");
    }
}

// ------------------------------------------------------------------
// Find libhoudini.so base via /proc/self/maps
// ------------------------------------------------------------------

fn find_houdini_base() -> Option<usize> {
    let mut buf = [0u8; 131072];
    let fd = unsafe { libc::open(b"/proc/self/maps\0".as_ptr() as *const i8, libc::O_RDONLY) };
    if fd < 0 {
        return None;
    }
    let mut total = 0usize;
    loop {
        let n = unsafe {
            libc::read(
                fd,
                buf[total..].as_mut_ptr() as *mut c_void,
                buf.len() - total,
            )
        };
        if n <= 0 {
            break;
        }
        total += n as usize;
        if total >= buf.len() {
            break;
        }
    }
    unsafe { libc::close(fd) };
    if total == 0 {
        return None;
    }
    let maps = unsafe { core::str::from_utf8_unchecked(&buf[..total]) };
    let mut base: Option<usize> = None;
    for line in maps.lines() {
        if !line.contains("libhoudini.so") {
            continue;
        }
        let dash = line.find('-')?;
        let addr = usize::from_str_radix(line[..dash].trim(), 16).ok()?;
        match base {
            None => base = Some(addr),
            Some(b) if addr < b => base = Some(addr),
            _ => {}
        }
    }
    base
}

// ------------------------------------------------------------------
// logcat
// ------------------------------------------------------------------

extern "C" {
    fn __android_log_write(prio: i32, tag: *const i8, text: *const i8) -> i32;
}

fn log(msg: &[u8]) {
    let tag = b"wzry_hook\0";
    unsafe {
        __android_log_write(4, tag.as_ptr() as *const i8, msg.as_ptr() as *const i8);
    }
}

// ------------------------------------------------------------------
// Install: 3-byte runtime patch at libhoudini.so + 0x324eef.
// Returns 1=patched, 2=mismatch (likely already patched), 3=no base.
// ------------------------------------------------------------------

unsafe fn install_hook() -> u8 {
    let base = match find_houdini_base() {
        Some(b) => b,
        None => return 3,
    };
    let target = base + PATCH_RVA;
    let current = core::slice::from_raw_parts(target as *const u8, 3);
    if current == ORIG_BYTES {
        // fall through to patch
    } else if current[0] == PATCHED_OPCODE {
        return 1; // already patched by us: idempotent success
    } else {
        return 2; // unexpected bytes: wrong lib version or RVA drift
    }

    let page = 0x1000usize;
    let start = target & !(page - 1);
    let len = ((target + 2) & !(page - 1)) - start + page;
    if libc::mprotect(
        start as *mut c_void,
        len,
        libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC,
    ) != 0
    {
        return 3;
    }
    core::ptr::copy_nonoverlapping(PATCH_BYTES.as_ptr(), target as *mut u8, 3);
    libc::mprotect(start as *mut c_void, len, libc::PROT_READ | libc::PROT_EXEC);
    1
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
