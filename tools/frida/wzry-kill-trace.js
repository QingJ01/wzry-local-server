'use strict';

// Kill-path tracer for com.tencent.tmgp.sgame on x86_64 (MuMu / Houdini).
// Attach-mode only. Records caller, args, module/offset, thread, timestamp,
// and native backtrace for every process-termination-related call site.

const SELF_PID = Process.id;
const SELF_TID = Process.getCurrentThreadId();
const MAX_FRAMES = 24;
const BOOT_TIME = Date.now();

const signalNames = {
    1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP',
    6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 10: 'SIGUSR1',
    11: 'SIGSEGV', 12: 'SIGUSR2', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM',
    16: 'SIGSTKFLT', 17: 'SIGCHLD', 18: 'SIGCONT', 19: 'SIGSTOP', 20: 'SIGTSTP',
    21: 'SIGTTIN', 22: 'SIGTTOU', 23: 'SIGURG', 24: 'SIGXCPU', 25: 'SIGXFSZ',
    26: 'SIGVTALRM', 27: 'SIGPROF', 28: 'SIGWINCH', 29: 'SIGIO', 30: 'SIGPWR',
    31: 'SIGSYS'
};

function signalName(sig) {
    return signalNames[sig] || ('SIG' + sig);
}

function describeAddress(address) {
    if (address === undefined || address === null) {
        return null;
    }
    const info = { address: address.toString() };
    try {
        const module = Process.findModuleByAddress(address);
        if (module !== null) {
            info.module = module.name;
            info.moduleBase = module.base.toString();
            info.moduleOffset = address.sub(module.base).toString();
            info.modulePath = module.path;
        }
    } catch (error) {
    }
    try {
        const symbol = DebugSymbol.fromAddress(address);
        if (symbol !== null && (symbol.name !== null || symbol.moduleName !== null)) {
            info.symbol = symbol.name || null;
            info.symbolModule = symbol.moduleName || null;
        }
    } catch (error) {
    }
    return info;
}

function captureBacktrace(context) {
    const frames = [];
    try {
        const backtrace = Thread.backtrace(context, Backtracer.ACCURATE);
        for (const frame of backtrace.slice(0, MAX_FRAMES)) {
            frames.push(describeAddress(frame));
        }
    } catch (error) {
        frames.push({ error: String(error) });
    }
    return frames;
}

function callerInfo(context) {
    let returnAddress = null;
    if (typeof context.returnAddress !== 'undefined' && context.returnAddress !== null) {
        returnAddress = context.returnAddress;
    } else if (context.arch === 'x64' || context.arch === 'ia32') {
        try {
            returnAddress = context.sp.readPointer();
        } catch (error) {
            returnAddress = null;
        }
    }
    return {
        returnAddress: returnAddress !== null ? returnAddress.toString() : null,
        caller: returnAddress !== null ? describeAddress(returnAddress) : null,
        pc: context.pc !== undefined ? context.pc.toString() : null,
        arch: context.arch || null
    };
}

function logEvent(type, payload, context) {
    const event = {
        timestamp: new Date().toISOString(),
        uptimeMs: Date.now() - BOOT_TIME,
        type: type,
        pid: SELF_PID,
        tid: Process.getCurrentThreadId()
    };
    if (payload !== undefined && payload !== null) {
        for (const key of Object.keys(payload)) {
            event[key] = payload[key];
        }
    }
    if (context !== undefined && context !== null) {
        const caller = callerInfo(context);
        event.returnAddress = caller.returnAddress;
        event.caller = caller.caller;
        event.pc = caller.pc;
        event.arch = caller.arch;
        event.backtrace = captureBacktrace(context);
    }
    send(event);
}

function hookExport(exportName, callbacks) {
    const address = Module.findGlobalExportByName(exportName);
    if (!address) {
        logEvent('hook-missing', { export: exportName });
        return;
    }
    Interceptor.attach(address, callbacks);
    logEvent('hook-attached', { export: exportName, address: address.toString() });
}

// --- libc kill/raise/abort family ----------------------------------------

hookExport('kill', {
    onEnter: function (args) {
        const pid = args[0].toInt32();
        const sig = args[1].toInt32();
        logEvent('call', {
            function: 'kill',
            args: { pid: pid, sig: sig, sigName: signalName(sig) },
            targetsSelf: pid === SELF_PID || pid === 0 || pid === -1
        }, this.context);
    },
    onLeave: function (result) {
        logEvent('call-result', { function: 'kill', result: result.toInt32() });
    }
});

hookExport('raise', {
    onEnter: function (args) {
        const sig = args[0].toInt32();
        logEvent('call', {
            function: 'raise',
            args: { sig: sig, sigName: signalName(sig) },
            targetsSelf: true
        }, this.context);
    }
});

hookExport('pthread_kill', {
    onEnter: function (args) {
        const sig = args[1].toInt32();
        logEvent('call', {
            function: 'pthread_kill',
            args: { pthread: args[0].toString(), sig: sig, sigName: signalName(sig) }
        }, this.context);
    }
});

hookExport('tgkill', {
    onEnter: function (args) {
        const tgid = args[0].toInt32();
        const tid = args[1].toInt32();
        const sig = args[2].toInt32();
        logEvent('call', {
            function: 'tgkill',
            args: { tgid: tgid, tid: tid, sig: sig, sigName: signalName(sig) },
            targetsSelf: tgid === SELF_PID
        }, this.context);
    }
});

hookExport('abort', {
    onEnter: function () {
        logEvent('call', { function: 'abort', args: {} }, this.context);
    }
});

hookExport('exit', {
    onEnter: function (args) {
        logEvent('call', { function: 'exit', args: { status: args[0].toInt32() } }, this.context);
    }
});

hookExport('_exit', {
    onEnter: function (args) {
        logEvent('call', { function: '_exit', args: { status: args[0].toInt32() } }, this.context);
    }
});

hookExport('_Exit', {
    onEnter: function (args) {
        logEvent('call', { function: '_Exit', args: { status: args[0].toInt32() } }, this.context);
    }
});

hookExport('exit_group', {
    onEnter: function (args) {
        logEvent('call', { function: 'exit_group', args: { status: args[0].toInt32() } }, this.context);
    }
});

hookExport('sigqueue', {
    onEnter: function (args) {
        const pid = args[0].toInt32();
        const sig = args[1].toInt32();
        logEvent('call', {
            function: 'sigqueue',
            args: { pid: pid, sig: sig, sigName: signalName(sig) },
            targetsSelf: pid === SELF_PID
        }, this.context);
    }
});

// --- raw syscall() dispatcher: catches direct kill/tkill/tgkill/exit_group --

const syscallFn = Module.findGlobalExportByName('syscall');
if (syscallFn) {
    Interceptor.attach(syscallFn, {
        onEnter: function (args) {
            const number = args[0].toInt32();
            // x86_64: 62=kill, 200=tkill, 234=tgkill, 60=exit, 231=exit_group
            if (number === 62 || number === 200 || number === 234) {
                const a = args[1].toInt32();
                const b = args[2].toInt32();
                const c = number === 234 ? args[3].toInt32() : null;
                logEvent('syscall', {
                    function: 'syscall',
                    syscallNumber: number,
                    syscallName: number === 62 ? 'kill' : (number === 200 ? 'tkill' : 'tgkill'),
                    args: number === 234
                        ? { tgid: a, tid: b, sig: c, sigName: signalName(c) }
                        : { pid: a, sig: b, sigName: signalName(b) },
                    targetsSelf: number === 62
                        ? (a === SELF_PID || a === 0 || a === -1)
                        : (a === SELF_PID || a === SELF_PID)
                }, this.context);
            } else if (number === 60 || number === 231) {
                logEvent('syscall', {
                    function: 'syscall',
                    syscallNumber: number,
                    syscallName: number === 60 ? 'exit' : 'exit_group',
                    args: { status: args[1].toInt32() }
                }, this.context);
            }
        }
    });
    logEvent('hook-attached', { export: 'syscall(filtered)', address: syscallFn.toString() });
} else {
    logEvent('hook-missing', { export: 'syscall' });
}

// --- module map snapshot for post-hoc offset resolution ---------------------

const moduleSnapshot = [];
for (const module of Process.enumerateModules()) {
    moduleSnapshot.push({
        name: module.name,
        base: module.base.toString(),
        size: module.size,
        path: module.path
    });
}

logEvent('session-started', {
    package: 'com.tencent.tmgp.sgame',
    script: 'wzry-kill-trace',
    selfPid: SELF_PID,
    selfTid: SELF_TID,
    moduleCount: moduleSnapshot.length
});
send({ type: 'module-map', timestamp: new Date().toISOString(), modules: moduleSnapshot });
