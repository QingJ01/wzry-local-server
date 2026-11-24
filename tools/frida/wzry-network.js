'use strict';

const connectedSockets = new Map();
const maximumPreviewBytes = 64;

function logEvent(type, payload) {
    const event = {
        timestamp: new Date().toISOString(),
        type: type,
        ...payload
    };
    console.log(JSON.stringify(event));
}

function readPreview(address, length) {
    const previewLength = Math.min(length, maximumPreviewBytes);
    if (previewLength <= 0 || address.isNull()) {
        return '';
    }
    try {
        return hexdump(address, { length: previewLength, ansi: false, header: false });
    } catch (error) {
        return `<preview-error:${error.message}>`;
    }
}

function readSocketFamily(sockaddr) {
    if (sockaddr.isNull()) {
        return null;
    }
    try {
        return Memory.readU16(sockaddr);
    } catch (error) {
        return null;
    }
}

function readSocketAddress(sockaddr) {
    const family = readSocketFamily(sockaddr);
    if (family === 2) {
        const bytes = Memory.readByteArray(sockaddr.add(4), 4);
        const octets = new Uint8Array(bytes);
        const port = (octets[0] << 8) | octets[1];
        return {
            family: 'AF_INET',
            address: `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`,
            port: port
        };
    }
    if (family === 10) {
        const bytes = Memory.readByteArray(sockaddr.add(8), 16);
        const octets = new Uint8Array(bytes);
        const words = [];
        for (let index = 0; index < 16; index += 2) {
            words.push(((octets[index] << 8) | octets[index + 1]).toString(16));
        }
        const port = (octets[0] << 8) | octets[1];
        return {
            family: 'AF_INET6',
            address: words.join(':'),
            port: port
        };
    }
    return {
        family: family === null ? null : `AF_${family}`,
        address: null,
        port: null
    };
}

function hookExport(moduleName, exportName, callbacks) {
    const address = Module.findExportByName(moduleName, exportName);
    if (!address) {
        logEvent('hook-missing', { module: moduleName, export: exportName });
        return;
    }
    Interceptor.attach(address, callbacks);
    logEvent('hook-attached', { module: moduleName, export: exportName });
}

hookExport('libc.so', 'connect', {
    onEnter: function (args) {
        this.descriptor = args[0].toInt32();
        this.address = readSocketAddress(args[1]);
    },
    onLeave: function (result) {
        const returnValue = result.toInt32();
        if (returnValue === 0) {
            connectedSockets.set(this.descriptor, this.address);
        }
        logEvent('connect', {
            descriptor: this.descriptor,
            result: returnValue,
            address: this.address
        });
    }
});

function hookDataCall(exportName, direction) {
    hookExport('libc.so', exportName, {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
            this.buffer = args[1];
            this.length = args[2].toInt32();
        },
        onLeave: function (result) {
            logEvent(direction, {
                function: exportName,
                descriptor: this.descriptor,
                result: result.toInt32(),
                requestedLength: this.length,
                address: connectedSockets.get(this.descriptor) || null,
                preview: readPreview(this.buffer, this.length)
            });
        }
    });
}

hookDataCall('send', 'send');
hookDataCall('recv', 'recv');

logEvent('session-started', {
    package: 'com.tencent.tmgp.sgame',
    maximumPreviewBytes: maximumPreviewBytes
});
