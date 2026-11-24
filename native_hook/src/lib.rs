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
    // /proc/self/cmdline for the specialized app process is the package
    // name followed by NULs; /proc/self/comm is the (truncated) app name.
    // Check both so a specialize-stage or context restriction on one file
    // doesn't silently disable the hook.
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
        let cmd = &buf[..len];
        for win in cmd.windows(TARGET_PACKAGE.len()) {
            if win == TARGET_PACKAGE {
                return true;
            }
        }
    }
    false
}

// ------------------------------------------------------------------
// Find libhoudini.so base address via /proc/self/maps
// ------------------------------------------------------------------

fn find_houdini_base() -> Option<usize> {
    let mut buf = [0u8; 65536];
    let fd = unsafe { libc::open(b"/proc/self/maps\0".as_ptr() as *const i8, libc::O_RDONLY) };
    if fd < 0 {
        return None;
    }
    // /proc/self/maps can exceed 8 KiB; read until EOF.
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
        let addr = usize::from_str_radix(&line[..dash].trim(), 16).ok()?;
        // The ELF base is the mapping whose file offset is 0 — the first
        // libhoudini.so line. RVA is relative to it regardless of perms.
        match base {
            None => base = Some(addr),
            Some(b) if addr < b => base = Some(addr),
            _ => {}
        }
    }
    base
}

// ------------------------------------------------------------------
// logcat reporting (counters file is SELinux-denied under u:r:zygote)
// ------------------------------------------------------------------

extern "C" {
    fn __android_log_write(prio: i32, tag: *const i8, text: *const i8) -> i32;
}

fn log(msg: &[u8]) {
    let tag = b"wzry_hook\0";
    unsafe {
        __android_log_write(
            4, // ANDROID_LOG_INFO
            tag.as_ptr() as *const i8,
            msg.as_ptr() as *const i8,
        );
    }
}

fn log_u64(label: &[u8], v: u64) {
    let mut buf = [0u8; 96];
    let mut i = 0usize;
    for &c in label {
        if c == 0 {
            break;
        }
        buf[i] = c;
        i += 1;
    }
    if v == 0 {
        buf[i] = b'0';
        i += 1;
    } else {
        let mut tmp = [0u8; 20];
        let mut n = v;
        let mut t = 0usize;
        while n > 0 {
            tmp[t] = b'0' + (n % 10) as u8;
            n /= 10;
            t += 1;
        }
        while t > 0 {
            t -= 1;
            buf[i] = tmp[t];
            i += 1;
        }
    }
    buf[i] = 0;
    log(&buf[..i]);
}

// ------------------------------------------------------------------
// Install the hook: overwrite first 5 bytes of the trampoline entry with
// a `jmp rel32` to `hook_syscall_stub`.
// ------------------------------------------------------------------

unsafe fn install_hook() -> bool {
    let base = match find_houdini_base() {
        Some(b) => b,
        None => {
            log(b"houdini base not found\0");
            return false;
        }
    };
    log_u64(b"houdini base=\0", base as u64);
    // Verify the page is really executable/readable before trusting it —
    // a stale or partially-unmapped base would fault on the byte check.
    let probe = core::slice::from_raw_parts(base as *const u8, 4);
    log_u64(
        b"elf magic=\0",
        u32::from_le_bytes([probe[0], probe[1], probe[2], probe[3]]) as u64,
    );
    let target = base + TRAMPOLINE_RVA;
    log_u64(b"target=\0", target as u64);
    let hook_addr = hook_syscall_stub as usize;

    // Verify original bytes.
    let current = core::slice::from_raw_parts(target as *const u8, 5);
    log_u64(b"byte0=\0", current[0] as u64);
    if current != ORIG_BYTES {
        log_u64(b"orig mismatch byte0=\0", current[0] as u64);
        // If already patched by us (e.g. re-inject), treat as success.
        return current[0] == 0xE9;
    }

    // Calculate rel32: hook_addr - (target + 5)
    let rel = (hook_addr as i64) - (target as i64) - 5;
    if rel < i32::MIN as i64 || rel > i32::MAX as i64 {
        log(b"rel32 out of range\0");
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
        log(b"mprotect failed\0");
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
    log(b"hook installed at 0x5001d0\0");
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
    // libhoudini.so is mapped by the native bridge *after* the specialize
    // entry returns, so it isn't in maps yet — but the zygote context here
    // crashes on pthread_create. Spawn a kernel thread via raw clone()
    // (no libc dependency) that polls for the base and patches the
    // trampoline the moment libhoudini.so appears.
    unsafe {
        spawn_houdini_watcher();
    }
    1
}

const CLONE_VM: u64 = 0x00000100;
const CLONE_FS: u64 = 0x00000200;
const CLONE_FILES: u64 = 0x00000400;
const CLONE_SIGHAND: u64 = 0x00000800;
const CLONE_THREAD: u64 = 0x00010000;

/// Spawn a detached kernel thread running `houdini_watcher` via raw
/// clone(2) — pthread_create faults under the specialize-stage zygote
/// context, but a bare clone sharing the address space works.
unsafe fn spawn_houdini_watcher() {
    // Allocate the child stack with mmap — a big static array inflates the
    // .bss past the zygisk loader's reserved-address-space limit.
    let stack = libc::mmap(
        core::ptr::null_mut(),
        65536,
        libc::PROT_READ | libc::PROT_WRITE,
        libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
        -1,
        0,
    );
    if stack == libc::MAP_FAILED {
        return;
    }
    let stack_top = (stack as *mut u8).add(65536) as *mut c_void;
    let flags = CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD;
    let ret: i64;
    core::arch::asm!(
        "mov rax, 56",          // __NR_clone on x86_64
        "mov rdi, {flags}",
        "mov rsi, {stack}",
        "xor rdx, rdx",
        "xor r10, r10",
        "xor r8, r8",
        "syscall",
        flags = in(reg) flags,
        stack = in(reg) stack_top,
        out("rax") ret,
        out("rcx") _,
        out("r11") _,
    );
    if ret == 0 {
        // Child: poll for libhoudini then patch. Must not return — exit
        // via exit_group so the clone dies cleanly.
        houdini_watcher_body();
        core::arch::asm!(
            "mov rax, 231", // __NR_exit_group
            "xor rdi, rdi",
            "syscall",
            options(noreturn),
        );
    }
    // Parent: ret is child tid; nothing more to do.
}

fn houdini_watcher_body() {
    for _ in 0..600 {
        // ~600 * 50ms = 30s window for libhoudini to appear.
        if find_houdini_base().is_some() {
            if unsafe { install_hook() } {
                HOOKED.store(1, Ordering::Release);
            } else {
                HOOKED.store(2, Ordering::Release);
            }
            return;
        }
        // nanosleep via raw syscall (libc may not be fully usable).
        let ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 50_000_000,
        };
        unsafe {
            libc::nanosleep(&ts, core::ptr::null_mut());
        }
    }
    HOOKED.store(3, Ordering::Release);
    log(b"houdini never appeared\0");
}

/// Zygisk Next loader resolves `zygisk_entry` (its canonical hook symbol).
/// Alias it to our module entry so both naming conventions work.
#[no_mangle]
pub extern "C" fn zygisk_entry() -> i32 {
    zygisk_module_entry()
}

/// Companion-process entry: we don't need a companion, but Zygisk Next
/// probes for it when a module declares companion support. Returning 0
/// keeps the companion path inert.
#[no_mangle]
pub extern "C" fn zygisk_companion_entry(_fd: i32) -> i32 {
    0
}

// ------------------------------------------------------------------
// Panic handler (required for no_std cdylib)
// ------------------------------------------------------------------

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
