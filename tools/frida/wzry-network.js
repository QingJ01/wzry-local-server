'use strict';

const maximumPreviewBytes = 64;
const socketDescriptors = new Map();
const connectedSockets = new Map();
const descriptorInodes = new Map();

const readlinkAddress = Module.findGlobalExportByName('readlink');
const readlink = readlinkAddress
    ? new NativeFunction(readlinkAddress, 'int', ['pointer', 'pointer', 'size_t'])
    : null;

function logEvent(type, payload) {
    const event = {
        timestamp: new Date().toISOString(),
        type: type,
        ...payload
    };
    send(event);
}

function formatHex(bytes) {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function readPreviewHex(address, length) {
    const previewLength = Math.min(length, maximumPreviewBytes);
    if (previewLength <= 0 || !address || address.isNull()) {
        return {
            hex: null,
            truncated: false
        };
    }

    try {
        const bytes = new Uint8Array(address.readByteArray(previewLength));
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
        return sockaddr.readU16();
    } catch (error) {
        return null;
    }
}

function readSocketAddress(sockaddr) {
    const family = readSocketFamily(sockaddr);
    if (family === 2) {
        const portBytes = new Uint8Array(sockaddr.add(2).readByteArray(2));
        const addressBytes = new Uint8Array(sockaddr.add(4).readByteArray(4));
        return {
            family: 'AF_INET',
            address: `${addressBytes[0]}.${addressBytes[1]}.${addressBytes[2]}.${addressBytes[3]}`,
            port: (portBytes[0] << 8) | portBytes[1]
        };
    }
    if (family === 10) {
        const portBytes = new Uint8Array(sockaddr.add(2).readByteArray(2));
        const addressBytes = new Uint8Array(sockaddr.add(8).readByteArray(16));
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

function isAdbReverseAddress(address) {
    return address !== null && (
        (address.family === 'AF_INET' && address.address === '127.0.0.1') ||
        (address.family === 'AF_INET6' && (address.address === '::1' || address.address === '::ffff:127.0.0.1'))
    );
}

function socketClass(address, domain) {
    if (isAdbReverseAddress(address)) {
        return 'local-adb-reverse';
    }
    if (address !== null && (address.family === 'AF_INET' || address.family === 'AF_INET6')) {
        return 'network';
    }
    if (domain === 1) {
        return 'AF_UNIX';
    }
    return null;
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

function isNetworkDomain(domain) {
    return domain === 2 || domain === 10;
}

function readSocketInode(descriptor) {
    if (descriptorInodes.has(descriptor)) {
        return descriptorInodes.get(descriptor);
    }
    if (readlink === null) {
        return null;
    }

    try {
        const pathBuffer = Memory.allocUtf8String(`/proc/self/fd/${descriptor}`);
        const resultBuffer = Memory.alloc(128);
        const length = readlink(pathBuffer, resultBuffer, 127);
        if (length <= 0) {
            return null;
        }

        const link = resultBuffer.readUtf8String(length);
        const match = link !== null ? link.match(/socket:\[(\d+)\]/) : null;
        const inode = match !== null ? Number(match[1]) : null;
        descriptorInodes.set(descriptor, inode);
        return inode;
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
        source: peerAddress !== null
            ? 'peer-address'
            : (knownAddress !== null ? 'connect' : (socketDescriptors.has(descriptor) ? 'descriptor' : null))
    };
}

function isSocketDescriptor(descriptor) {
    if (connectedSockets.has(descriptor) || descriptorInodes.has(descriptor)) {
        return true;
    }
    const socketDescriptor = socketDescriptors.get(descriptor);
    return socketDescriptor !== undefined && isNetworkDomain(socketDescriptor.domain);
}

function isLikelySocketDescriptor(descriptor) {
    if (isSocketDescriptor(descriptor)) {
        return true;
    }

    try {
        const peer = Socket.peerAddress(descriptor);
        return peer !== null && peer.ip !== undefined;
    } catch (error) {
        return false;
    }
}

function hookExport(moduleName, exportName, callbacks) {
    const address = Module.findGlobalExportByName(exportName);
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
            const inode = readSocketInode(descriptor);
            logEvent('socket', {
                socketType: this.type,
                descriptor: descriptor,
                domain: this.domain,
                network: isNetworkDomain(this.domain),
                socketInode: inode,
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
            const descriptorState = socketDescriptors.get(this.descriptor);
            const socketKind = socketClass(
                this.address,
                descriptorState !== undefined ? descriptorState.domain : null
            );
            const network = socketKind === 'network' || socketKind === 'local-adb-reverse';
            if (network && !connectedSockets.has(this.descriptor)) {
                connectedSockets.set(this.descriptor, this.address);
            }

            logEvent('connect', {
                descriptor: this.descriptor,
                result: returnValue,
                endpoint: this.address,
                socketClass: socketKind,
                network: socketKind !== null,
                socketInode: readSocketInode(this.descriptor)
            });
        }
    });
}

function readIovec(iov, count) {
    let requestedLength = 0;
    let previewAddress = null;
    for (let index = 0; index < count; index += 1) {
        const entry = iov.add(index * 16);
        const base = entry.readPointer();
        const rawLength = entry.add(8).readU64();
        const length = typeof rawLength.toNumber === 'function' ? rawLength.toNumber() : Number(rawLength);
        requestedLength += length;
        if (previewAddress === null && length > 0 && !base.isNull()) {
            previewAddress = base;
        }
    }
    return { requestedLength, previewAddress };
}

function logSocketData(functionName, direction, descriptor, result, requestedLength, buffer) {
    if (!isLikelySocketDescriptor(descriptor)) {
        return;
    }

    const actualLength = result > 0 ? result : 0;
    const socketDescriptor = socketDescriptors.get(descriptor);
    if (socketDescriptor !== undefined && !isNetworkDomain(socketDescriptor.domain)) {
        return;
    }

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
        socketInode: readSocketInode(descriptor),
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

function hookVectorCall(exportName, direction) {
    hookExport('libc.so', exportName, {
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

function hookMessageCall(exportName, direction) {
    hookExport('libc.so', exportName, {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
            const messageHeader = args[1];
            this.iovec = messageHeader.add(16).readPointer();
            const rawCount = messageHeader.add(24).readU64();
            this.count = typeof rawCount.toNumber === 'function' ? rawCount.toNumber() : Number(rawCount);
            const iovec = readIovec(this.iovec, this.count);
            this.requestedLength = iovec.requestedLength;
            this.buffer = iovec.previewAddress;
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
            descriptorInodes.delete(this.descriptor);
            logEvent('socket-close', {
                descriptor: this.descriptor,
                endpoint: endpoint,
                result: result.toInt32()
            });
        }
    });
}

function hookAccept(exportName) {
    hookExport('libc.so', exportName, {
        onEnter: function (args) {
            this.descriptor = args[0].toInt32();
        },
        onLeave: function (result) {
            const acceptedDescriptor = result.toInt32();
            if (acceptedDescriptor < 0) {
                return;
            }

            const endpoint = readPeerAddress(acceptedDescriptor);
            if (endpoint !== null) {
                connectedSockets.set(acceptedDescriptor, endpoint);
            } else {
                socketDescriptors.set(acceptedDescriptor, {
                    domain: 2,
                    type: 1,
                    protocol: 0,
                    origin: exportName
                });
            }

            logEvent('socket-accepted', {
                function: exportName,
                descriptor: acceptedDescriptor,
                listenDescriptor: this.descriptor,
                endpoint: endpoint
            });
        }
    });
}

hookSocketCreation();
hookConnect();
hookAccept('accept');
hookAccept('accept4');
hookSimpleDataCall('send', 'outbound');
hookSimpleDataCall('recv', 'inbound');
hookSimpleDataCall('write', 'outbound');
hookSimpleDataCall('read', 'inbound');
hookDatagramCall('sendto', 'outbound');
hookDatagramCall('recvfrom', 'inbound');
hookVectorCall('writev', 'outbound');
hookVectorCall('readv', 'inbound');
hookMessageCall('sendmsg', 'outbound');
hookMessageCall('recvmsg', 'inbound');
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
        'readv',
        'sendmsg',
        'recvmsg',
        'shutdown',
        'close'
    ]
});
