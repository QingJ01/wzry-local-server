//! Houdini self-SIGKILL hook prototype.
//!
//! Loaded into `com.tencent.tmgp.sgame` by Zygisk/LSPosed. Patches the
//! `libhoudini.so` syscall trampoline entry (0x5001d0) so that guest-ARM
//! `svc kill/tgkill/tkill` targeting the host process itself with signo=9
//! is silently dropped (return 0), while all other syscalls pass through.
//!
//! Evidence: `reports/houdini_selfkill_analysis_20261124.md`
//!   - trampoline `0x5001d0` = `mov rax,rdi; syscall; ret` (arg-count 0 stub,
//!     shared entry for getpid/gettid and the guest-syscall dispatcher)
//!   - decision fn `0x324e80` emits `houdini [SIGKILL] kill:` then issues the
//!     real host syscall.

#![no_std]

use core::ffi::c_void;
use core::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

/// Package name filter: only hook when running inside the target process.
const TARGET_PACKAGE: &[u8] = b"com.tencent.tmgp.sgame";

/// Absolute path of the libhoudini.so we instrument.
const HOUDINI_SO: &[u8] = b"libhoudini.so";

/// RVA of the 0-arg syscall trampoline stub inside libhoudini.so.
/// `0x5001d0` → `mov rax,rdi; syscall; ret` (verified bytes e9 6b 00 00 00
/// at 0x5001d0 jump to 0x500240 which is `mov rax,rdi; syscall; ret`).
const TRAMPOLINE_RVA: usize = 0x5001d0;

/// Android/x86_64 syscall numbers for the kill family.
const SYS_KILL: u64 = 62;
const SYS_TKILL: u64 = 200;
const SYS_TGKILL: u64 = 234;

/// SIGKILL.
const SIGKILL: u64 = 9;

// ------------------------------------------------------------------
// Trampoline original bytes (5 bytes for our JMP rel32 patch)
// ------------------------------------------------------------------

/// Original 5 bytes at `0x5001d0`: `E9 6B 00 00 00` (jmp 0x500240).
static ORIG_BYTES: [u8; 5] = [0xE9, 0x6B, 0x00, 0x00, 0x00];

// ------------------------------------------------------------------
// Counters (visible via /data/local/tmp/wzry_hook_counters.bin)
// ------------------------------------------------------------------

static HOOKED: AtomicUsize = AtomicUsize::new(0);
static INTERCEPTED: AtomicU64 = AtomicU64::new(0);
static PASSTHRU: AtomicU64 = AtomicU64::new(0);

// ------------------------------------------------------------------
// Helper: get own pid/tid via raw syscalls (avoid libc dep at hook level)
// ------------------------------------------------------------------

#[inline(always)]
fn raw_getpid() -> u64 {
    let ret: u64;
    unsafe {
        core::arch::asm!(
            "mov rax, 39",      // __NR_getpid
            "syscall",
            out("rax") ret,
            out("rcx") _,
            out("r11") _,
        );
    }
    ret
}

#[inline(always)]
fn raw_gettid() -> u64 {
    let ret: u64;
    unsafe {
        core::arch::asm!(
            "mov rax, 186",     // __NR_gettid
            "syscall",
            out("rax") ret,
            out("rcx") _,
            out("r11") _,
        );
    }
    ret
}

// ------------------------------------------------------------------
// Hook function: signature matches `mov rax,rdi; syscall; ret`
// The stub is called as `call trampoline` with syscall nr in `rdi`.
// Arguments: rdi=sysno, rsi=arg0, rdx=arg1, rcx=arg2, r8=arg3, r9=arg4
// (extra args go on the stack per the original stub chain, but kill-family
// only needs up to arg2).
// ------------------------------------------------------------------

/// Called instead of the original stub. Returns the syscall result.
/// Must preserve callee-saved regs per SysV ABI (the stub itself is a leaf,
/// caller treats it as `call` → `ret` so we just need to return a value in
/// rax and not clobber rbx/rbp/r12-r15).
#[no_mangle]
pub extern "C" fn hook_syscall_stub(
    sysno: u64,
    arg0: u64,
    arg1: u64,
    arg2: u64,
    arg3: u64,
    arg4: u64,
) -> u64 {
    // Fast path: not a kill-family syscall → passthrough.
    if sysno != SYS_KILL && sysno != SYS_TKILL && sysno != SYS_TGKILL {
        PASSTHRU.fetch_add(1, Ordering::Relaxed);
        return unsafe { do_real_syscall6(sysno, arg0, arg1, arg2, arg3, arg4, 0) };
    }

    let pid = raw_getpid();
    let tid = raw_gettid();

    // Determine if this is a self-targeted SIGKILL.
    let self_kill = match sysno {
        SYS_KILL => arg0 == pid && arg1 == SIGKILL,
        SYS_TKILL => arg0 == tid && arg1 == SIGKILL,
        SYS_TGKILL => arg0 == pid && arg1 == tid && arg2 == SIGKILL,
        _ => false,
    };

    if self_kill {
        INTERCEPTED.fetch_add(1, Ordering::Relaxed);
        // Return 0 (success) — the guest thinks the kill was delivered.
        return 0;
    }

    PASSTHRU.fetch_add(1, Ordering::Relaxed);
    unsafe { do_real_syscall6(sysno, arg0, arg1, arg2, arg3, arg4, 0) }
}

/// Perform the real syscall with up to 6 args.
/// `mov rax,rdi; mov rdi,rsi; mov rsi,rdx; mov rdx,rcx; mov r10,r8; mov r8,r9;
///  mov r9,[rsp+8]; syscall; ret`
#[inline(always)]
unsafe fn do_real_syscall6(
    sysno: u64,
    a0: u64,
    a1: u64,
    a2: u64,
    a3: u64,
    a4: u64,
    a5: u64,
) -> u64 {
    let ret: u64;
    core::arch::asm!(
        "mov rax, {sysno}",
        "mov rdi, {a0}",
        "mov rsi, {a1}",
        "mov rdx, {a2}",
        "mov r10, {a3}",
        "mov r8,  {a4}",
        "mov r9,  {a5}",
        "syscall",
        sysno = in(reg) sysno,
        a0 = in(reg) a0,
        a1 = in(reg) a1,
        a2 = in(reg) a2,
        a3 = in(reg) a3,
        a4 = in(reg) a4,
        a5 = in(reg) a5,
        out("rax") ret,
        out("rcx") _,
        out("r11") _,
    );
    ret
}

// ------------------------------------------------------------------
// Process-name check (read /proc/self/cmdline)
// ------------------------------------------------------------------

fn is_target_process() -> bool {
    let mut buf = [0u8; 256];
    let fd = unsafe {
        libc::open(
            b"/proc/self/cmdline\0".as_ptr() as *const i8,
            libc::O_RDONLY,
        )
    };
    if fd < 0 {
        return false;
    }
    let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut c_void, buf.len() - 1) };
    unsafe { libc::close(fd) };
    if n <= 0 {
        return false;
    }
    let len = (n as usize).min(buf.len() - 1);
    // cmdline is NUL-separated; compare first entry
    let cmd = &buf[..len];
    // Find package name inside cmdline (it may be prefixed by process name)
    for win in cmd.windows(TARGET_PACKAGE.len()) {
        if win == TARGET_PACKAGE {
            return true;
        }
    }
    false
}

// ------------------------------------------------------------------
// Find libhoudini.so base address via /proc/self/maps
// ------------------------------------------------------------------

fn find_houdini_base() -> Option<usize> {
    let mut buf = [0u8; 8192];
    let fd = unsafe {
        libc::open(
            b"/proc/self/maps\0".as_ptr() as *const i8,
            libc::O_RDONLY,
        )
    };
    if fd < 0 {
        return None;
    }
    let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut c_void, buf.len() - 1) };
    unsafe { libc::close(fd) };
    if n <= 0 {
        return None;
    }
    let maps = unsafe { core::str::from_utf8_unchecked(&buf[..n as usize]) };
    for line in maps.lines() {
        if line.contains("libhoudini.so") && line.contains("r-xp") {
            // First executable mapping entry → base address
            if let Some(dash) = line.find('-') {
                if let Ok(addr) = usize::from_str_radix(&line[..dash].trim(), 16) {
                    return Some(addr);
                }
            }
        }
    }
    None
}

// ------------------------------------------------------------------
// Install the hook: overwrite first 5 bytes of the trampoline entry with
// a `jmp rel32` to `hook_syscall_stub`.
// ------------------------------------------------------------------

unsafe fn install_hook() -> bool {
    let base = match find_houdini_base() {
        Some(b) => b,
        None => return false,
    };
    let target = base + TRAMPOLINE_RVA;
    let hook_addr = hook_syscall_stub as usize;

    // Verify original bytes.
    let current = core::slice::from_raw_parts(target as *const u8, 5);
    if current != ORIG_BYTES {
        // If already patched by us (e.g. re-inject), treat as success.
        return current[0] == 0xE9;
    }

    // Calculate rel32: hook_addr - (target + 5)
    let rel = (hook_addr as i64) - (target as i64) - 5;
    if rel < i32::MIN as i64 || rel > i32::MAX as i64 {
        return false; // out of range, need a different strategy
    }
    let rel32 = rel as i32;

    // Unprotect the page.
    let page_size = 0x1000usize;
    let page_start = target & !(page_size - 1);
    let page_end = (target + 4) & !(page_size - 1);
    let protect_len = page_end - page_start + page_size;
    if libc::mprotect(
        page_start as *mut c_void,
        protect_len,
        libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC,
    ) != 0
    {
        return false;
    }

    // Write jmp rel32.
    let patch: [u8; 5] = [
        0xE9,
        (rel32 & 0xFF) as u8,
        ((rel32 >> 8) & 0xFF) as u8,
        ((rel32 >> 16) & 0xFF) as u8,
        ((rel32 >> 24) & 0xFF) as u8,
    ];
    core::ptr::copy_nonoverlapping(patch.as_ptr(), target as *mut u8, 5);

    // Restore protection.
    libc::mprotect(
        page_start as *mut c_void,
        protect_len,
        libc::PROT_READ | libc::PROT_EXEC,
    );

    HOOKED.store(1, Ordering::Release);
    true
}

// ------------------------------------------------------------------
// Log helper — write counters to /data/local/tmp/wzry_hook_counters.bin
// ------------------------------------------------------------------

fn dump_counters() {
    let path = b"/data/local/tmp/wzry_hook_counters.bin\0";
    let fd = unsafe {
        libc::open(
            path.as_ptr() as *const i8,
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
            0o644,
        )
    };
    if fd < 0 {
        return;
    }
    let mut buf = [0u8; 24];
    buf[0..8].copy_from_slice(&(HOOKED.load(Ordering::Relaxed) as u64).to_le_bytes());
    buf[8..16].copy_from_slice(&INTERCEPTED.load(Ordering::Relaxed).to_le_bytes());
    buf[16..24].copy_from_slice(&PASSTHRU.load(Ordering::Relaxed).to_le_bytes());
    unsafe {
        libc::write(fd, buf.as_ptr() as *const c_void, 24);
        libc::close(fd);
    }
}

// ------------------------------------------------------------------
// Entry point — called by Zygisk/LSPosed after dlopen.
// ------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn zygisk_module_entry() -> i32 {
    if !is_target_process() {
        return 0;
    }
    if unsafe { install_hook() } {
        // Persist initial counters so testers can verify the hook landed.
        dump_counters();
        1
    } else {
        0
    }
}

// ------------------------------------------------------------------
// Panic handler (required for no_std cdylib)
// ------------------------------------------------------------------

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
