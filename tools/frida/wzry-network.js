'use strict';

const maximumPreviewBytes = 64;
const socketDescriptors = new Map();
const connectedSockets = new Map();

function logEvent(type, payload) {
    const event = {
        timestamp: new Date().toISOString(),
        type: type,
        ...payload
    };
    console.log(JSON.stringify(event));
}

function formatHex(bytes) {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function readPreviewHex(address, length) {
    const previewLength = Math.min(length, maximumPreviewBytes);
    if (previewLength <= 0 || address.isNull()) {
        return {
            hex: null,
            truncated: false
        };
    }

    try {
        const bytes = new Uint8Array(Memory.readByteArray(address, previewLength));
        return {
            hex: formatHex(bytes),
            truncated: length > previewLength
        };
    } catch (error) {
        return {
            hex: null,
            truncated: false,
            error: error.message
        };
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
        const portBytes = new Uint8Array(Memory.readByteArray(sockaddr.add(2), 2));
        const addressBytes = new Uint8Array(Memory.readByteArray(sockaddr.add(4), 4));
        return {
            family: 'AF_INET',
            address: `${addressBytes[0]}.${addressBytes[1]}.${addressBytes[2]}.${addressBytes[3]}`,
            port: (portBytes[0] << 8) | portBytes[1]
        };
    }
    if (family === 10) {
        const portBytes = new Uint8Array(Memory.readByteArray(sockaddr.add(2), 2));
        const addressBytes = new Uint8Array(Memory.readByteArray(sockaddr.add(8), 16));
        const words = [];
        for (let index = 0; index < 16; index += 2) {
            words.push(((addressBytes[index] << 8) | addressBytes[index + 1]).toString(16));
        }
        return {
            family: 'AF_INET6',
            address: words.join(':'),
            port: (portBytes[0] << 8) | portBytes[1]
        };
    }

    return {
        family: family === null ? null : `AF_${family}`,
        address: null,
        port: null
    };
}

function readPeerAddress(descriptor) {
    if (typeof Socket === 'undefined' || typeof Socket.peerAddress !== 'function') {
        return null;
    }

    try {
        const peer = Socket.peerAddress(descriptor);
        if (!peer || peer.ip === undefined) {
            return null;
        }
        return {
            family: peer.family || null,
            address: peer.ip,
            port: peer.port
        };
    } catch (error) {
        return null;
    }
}

function resolveEndpoint(descriptor) {
    const knownAddress = connectedSockets.get(descriptor) || null;
    const peerAddress = readPeerAddress(descriptor);
    if (peerAddress !== null) {
        connectedSockets.set(descriptor, peerAddress);
    }

    return {
        endpoint: peerAddress || knownAddress,
        source: peerAddress !== null ? 'peer-address' : (knownAddress !== null ? 'connect' : null)
    };
}

function isSocketDescriptor(descriptor) {
    return socketDescriptors.has(descriptor) || connectedSockets.has(descriptor);
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

function hookSocketCreation() {
    hookExport('libc.so', 'socket', {
        onEnter: function (args) {
            this.domain = args[0].toInt32();
            this.type = args[1].toInt32();
            this.protocol = args[2].toInt32();
        },
        onLeave: function (result) {
            const descriptor = result.toInt32();
            if (descriptor < 0) {
                return;
            }

            socketDescriptors.set(descriptor, {
                domain: this.domain,
                type: this.type,
                protocol: this.protocol
            });
            logEvent('socket', {
                descriptor: descriptor,
                domain: this.domain,
                type: this.type,
                protocol: this.protocol
            });
        }
    });
}

function hookConnect() {
    hookExport('libc.so', 'connect', {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
            this.address = readSocketAddress(args[1]);
        },
        onLeave: function (result) {
            const returnValue = result.toInt32();
            if (!connectedSockets.has(this.descriptor)) {
                connectedSockets.set(this.descriptor, this.address);
            }

            logEvent('connect', {
                descriptor: this.descriptor,
                result: returnValue,
                endpoint: this.address
            });
        }
    });
}

function readIovec(iov, count) {
    let requestedLength = 0;
    let previewAddress = null;
    for (let index = 0; index < count; index += 1) {
        const entry = iov.add(index * 16);
        const base = Memory.readPointer(entry);
        const rawLength = Memory.readU64(entry.add(8));
        const length = typeof rawLength.toNumber === 'function' ? rawLength.toNumber() : Number(rawLength);
        requestedLength += length;
        if (previewAddress === null && length > 0 && !base.isNull()) {
            previewAddress = base;
        }
    }
    return { requestedLength, previewAddress };
}

function logSocketData(functionName, direction, descriptor, result, requestedLength, buffer) {
    if (!isSocketDescriptor(descriptor)) {
        return;
    }

    const actualLength = result > 0 ? result : 0;
    const endpointState = resolveEndpoint(descriptor);
    if (endpointState.source === null) {
        return;
    }

    const preview = actualLength > 0
        ? readPreviewHex(buffer, actualLength)
        : { hex: null, truncated: false };
    logEvent('socket-data', {
        direction: direction,
        function: functionName,
        descriptor: descriptor,
        endpoint: endpointState.endpoint,
        endpointSource: endpointState.source,
        result: result,
        requestedLength: requestedLength,
        actualLength: actualLength,
        length: actualLength,
        previewHex: preview.hex,
        previewTruncated: preview.truncated,
        previewBytes: actualLength > 0 ? Math.min(actualLength, maximumPreviewBytes) : 0,
        previewError: preview.error || null
    });
}

function hookSimpleDataCall(exportName, direction) {
    hookExport('libc.so', exportName, {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
            this.buffer = args[1];
            this.requestedLength = args[2].toInt32();
        },
        onLeave: function (result) {
            logSocketData(
                exportName,
                direction,
                this.descriptor,
                result.toInt32(),
                this.requestedLength,
                this.buffer
            );
        }
    });
}

function hookDatagramCall(exportName, direction) {
    hookExport('libc.so', exportName, {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
            this.buffer = args[1];
            this.requestedLength = args[2].toInt32();
        },
        onLeave: function (result) {
            logSocketData(
                exportName,
                direction,
                this.descriptor,
                result.toInt32(),
                this.requestedLength,
                this.buffer
            );
        }
    });
}

function hookWritev() {
    hookExport('libc.so', 'writev', {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
            this.iovec = args[1];
            this.count = args[2].toInt32();
            const iovec = readIovec(this.iovec, this.count);
            this.requestedLength = iovec.requestedLength;
            this.buffer = iovec.previewAddress;
        },
        onLeave: function (result) {
            logSocketData(
                'writev',
                'outbound',
                this.descriptor,
                result.toInt32(),
                this.requestedLength,
                this.buffer
            );
        }
    });
}

function hookShutdown() {
    hookExport('libc.so', 'shutdown', {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
            this.how = args[1].toInt32();
        },
        onLeave: function (result) {
            if (!isSocketDescriptor(this.descriptor)) {
                return;
            }
            logEvent('socket-shutdown', {
                descriptor: this.descriptor,
                how: this.how,
                result: result.toInt32()
            });
        }
    });
}

function hookClose() {
    hookExport('libc.so', 'close', {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
        },
        onLeave: function (result) {
            if (!isSocketDescriptor(this.descriptor)) {
                return;
            }
            const endpoint = connectedSockets.get(this.descriptor) || null;
            socketDescriptors.delete(this.descriptor);
            connectedSockets.delete(this.descriptor);
            logEvent('socket-close', {
                descriptor: this.descriptor,
                endpoint: endpoint,
                result: result.toInt32()
            });
        }
    });
}

hookSocketCreation();
hookConnect();
hookSimpleDataCall('send', 'outbound');
hookSimpleDataCall('recv', 'inbound');
hookSimpleDataCall('write', 'outbound');
hookSimpleDataCall('read', 'inbound');
hookDatagramCall('sendto', 'outbound');
hookDatagramCall('recvfrom', 'inbound');
hookWritev();
hookShutdown();
hookClose();

logEvent('session-started', {
    package: 'com.tencent.tmgp.sgame',
    outputFormat: 'jsonl',
    maximumPreviewBytes: maximumPreviewBytes,
    hooks: [
        'socket',
        'connect',
        'send',
        'recv',
        'sendto',
        'recvfrom',
        'read',
        'write',
        'writev',
        'shutdown',
        'close'
    ]
});
