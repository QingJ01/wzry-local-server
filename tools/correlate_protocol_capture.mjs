'use strict';

import {
    createHash
} from 'node:crypto';
import {
    createReadStream
} from 'node:fs';
import {
    createInterface
} from 'node:readline';
import {
    fileURLToPath
} from 'node:url';
import {
    access,
    mkdir,
    readdir,
    readFile,
    stat,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';

const command = {
    sockets: [],
    frida: [],
    output: null,
    markdown: null,
    anchors: fileURLToPath(new URL('./config/protocol_anchor_catalog.json', import.meta.url))
};

function parseArguments(argv) {
    const argumentValues = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument !== '--sockets' && argument !== '--frida' && argument !== '--output' && argument !== '--markdown' && argument !== '--anchors') {
            throw new Error(`Unknown argument: ${argument}`);
        }
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for ${argument}`);
        }
        if (argumentValues.has(argument)) {
            throw new Error(`Argument repeated: ${argument}`);
        }
        argumentValues.set(argument, value);
    }

    if (!argumentValues.has('--sockets') || !argumentValues.has('--frida')) {
        throw new Error('--sockets and --frida are required; use a directory or an empty path to record absent evidence');
    }
    if (!argumentValues.has('--output') || !argumentValues.has('--markdown')) {
        throw new Error('--output and --markdown are required');
    }

    for (const value of argumentValues.get('--sockets')?.split(path.delimiter) ?? []) {
        if (value) {
            command.sockets.push(value);
        }
    }
    for (const value of argumentValues.get('--frida')?.split(path.delimiter) ?? []) {
        if (value) {
            command.frida.push(value);
        }
    }
    command.output = argumentValues.get('--output');
    command.markdown = argumentValues.get('--markdown');
    command.anchors = argumentValues.get('--anchors') ?? command.anchors;
}

async function exists(candidate) {
    try {
        await access(candidate);
        return true;
    } catch {
        return false;
    }
}

async function listFiles(root, extensions, recursive = true) {
    if (!(await exists(root))) {
        return [];
    }

    const entries = await readdir(root, {
        withFileTypes: true
    });
    const files = [];
    for (const entry of entries) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory() && recursive) {
            files.push(...await listFiles(entryPath, extensions, recursive));
        } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
            files.push(entryPath);
        }
    }
    return files.sort();
}

async function hashFile(filePath) {
    const hash = createHash('sha256');
    await pipelineFile(filePath, chunk => hash.update(chunk));
    return hash.digest('hex').toUpperCase();
}

async function pipelineFile(filePath, consume) {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => consume(chunk));
    await new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
    });
}

async function loadJsonObject(filePath) {
    const value = JSON.parse((await readFile(filePath)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Expected a JSON object in ${filePath}`);
    }
    return value;
}

async function loadJsonl(filePath, invalidLines, parseEvent) {
    const stream = createReadStream(filePath, {
        encoding: 'utf8'
    });
    const reader = createInterface({
        input: stream,
        crlfDelay: Infinity
    });
    let lineNumber = 0;
    let events = 0;
    let invalidLineCount = 0;
    for await (const line of reader) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const value = JSON.parse(trimmed);
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('JSONL event is not an object');
            }
            parseEvent(value, filePath, lineNumber);
            events += 1;
        } catch (error) {
            invalidLineCount += 1;
            invalidLines.push({
                source: filePath,
                line: lineNumber,
                error: error.message
            });
        }
    }
    return {
        events,
        invalidLineCount
    };
}

function parseEpoch(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function parseProcAddress(value) {
    const match = /^([0-9A-Fa-f]+):([0-9A-Fa-f]+)$/.exec(value || '');
    if (!match) {
        return null;
    }

    const addressHex = match[1];
    const port = Number.parseInt(match[2], 16);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return null;
    }

    if (addressHex.length === 8) {
        const bytes = [];
        for (let index = 0; index < 8; index += 2) {
            bytes.push(Number.parseInt(addressHex.slice(index, index + 2), 16));
        }
        return {
            family: 'AF_INET',
            address: bytes.join('.'),
            port
        };
    }

    if (addressHex.length === 32) {
        const words = [];
        for (let index = 0; index < 32; index += 8) {
            words.push(addressHex.slice(index, index + 8));
        }
        return {
            family: 'AF_INET6',
            address: words.join(':'),
            port
        };
    }

    return null;
}

function endpointKey(endpoint) {
    if (!endpoint || !endpoint.address || !Number.isInteger(endpoint.port)) {
        return null;
    }
    return `${(endpoint.family || 'unknown')}|${endpoint.address}|${endpoint.port}`;
}

function endpointClassification(endpoint) {
    const address = endpoint.address.toLowerCase();
    const port = endpoint.port;
    if (address === '127.0.0.1' || address === '::1') {
        return 'local-server';
    }
    if (port === 80 || port === 443) {
        return 'http-control-plane';
    }
    return 'game-candidate';
}

function createCollector() {
    return {
        invalid: [],
        socketSnapshots: [],
        socketConnections: [],
        fridaFiles: [],
        fridaEvents: [],
        endpoints: new Map()
    };
}

function recordEndpoint(collector, endpoint, source, options) {
    const key = endpointKey(endpoint);
    if (!key) {
        return;
    }

    if (!collector.endpoints.has(key)) {
        collector.endpoints.set(key, {
            key,
            endpoint,
            classification: endpointClassification(endpoint),
            sources: [],
            descriptors: [],
            states: [],
            observedPhases: [],
            directions: [],
            functions: [],
            timestamps: [],
            processOwnership: [],
            socketSnapshotCount: 0,
            fridaEventCount: 0,
            outboundEvents: 0,
            inboundEvents: 0,
            actualLengths: [],
            requestedLengths: []
        });
    }

    const record = collector.endpoints.get(key);
    if (!record.sources.includes(source)) {
        record.sources.push(source);
    }
    if (options.descriptor !== undefined && options.descriptor !== null && !record.descriptors.includes(options.descriptor)) {
        record.descriptors.push(options.descriptor);
    }
    if (options.state && !record.states.includes(options.state)) {
        record.states.push(options.state);
    }
    if (options.phase && !record.observedPhases.includes(options.phase)) {
        record.observedPhases.push(options.phase);
    }
    if (options.direction && !record.directions.includes(options.direction)) {
        record.directions.push(options.direction);
    }
    if (options.functionName && !record.functions.includes(options.functionName)) {
        record.functions.push(options.functionName);
    }
    if (options.timestamp !== null && options.timestamp !== undefined) {
        record.timestamps.push(options.timestamp);
    }
    if (options.processOwnership) {
        record.processOwnership.push(options.processOwnership);
    }
    if (source === 'process-socket') {
        record.socketSnapshotCount += 1;
    }
    if (source === 'frida') {
        record.fridaEventCount += 1;
        if (options.direction === 'outbound') {
            record.outboundEvents += 1;
        }
        if (options.direction === 'inbound') {
            record.inboundEvents += 1;
        }
        if (Number.isFinite(options.actualLength)) {
            record.actualLengths.push(options.actualLength);
        }
        if (Number.isFinite(options.requestedLength)) {
            record.requestedLengths.push(options.requestedLength);
        }
    }
}

function parseSocketSnapshot(documentValue, filePath) {
    const capturedAt = parseEpoch(documentValue.capturedAt);
    if (capturedAt === null) {
        throw new Error(`Socket snapshot ${filePath} has no valid capturedAt`);
    }
    if (!Array.isArray(documentValue.connections)) {
        throw new Error(`Socket snapshot ${filePath} has no connections array`);
    }

    return {
        source: filePath,
        sha256: null,
        capturedAt,
        serial: documentValue.serial || null,
        package: documentValue.package || null,
        processId: documentValue.processId || null,
        uid: documentValue.uid ?? null,
        connectionCount: documentValue.connections.length
    };
}

function parseSocketConnection(documentValue, snapshot) {
    const endpoint = parseProcAddress(documentValue.RemoteAddress);
    if (!endpoint) {
        return null;
    }

    const inode = Number(documentValue.Inode);
    return {
        endpoint,
        capturedAt: snapshot.capturedAt,
        table: documentValue.Table || null,
        state: documentValue.State || null,
        uid: Number.isFinite(documentValue.Uid) ? documentValue.Uid : null,
        inode: Number.isFinite(inode) ? inode : null
    };
}

function inferPhase(filePath) {
    const name = path.basename(filePath).toLowerCase();
    for (const phase of ['cold-start', 'login', 'lobby', 'room', 'battle', 'shop', 'settlement']) {
        if (name.includes(phase)) {
            return phase;
        }
    }
    return 'unlabeled';
}

function normalizeFridaEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'object') {
        return null;
    }
    const port = Number(endpoint.port);
    if (!endpoint.address || !Number.isInteger(port)) {
        return null;
    }
    return {
        family: endpoint.family || 'unknown',
        address: endpoint.address,
        port
    };
}

function parseFridaEvent(value, filePath, lineNumber) {
    const timestamp = parseEpoch(value.timestamp);
    return {
        source: filePath,
        line: lineNumber,
        timestamp,
        type: typeof value.type === 'string' ? value.type : 'unknown',
        phase: inferPhase(filePath),
        endpoint: normalizeFridaEndpoint(value.endpoint),
        descriptor: Number.isInteger(value.descriptor) ? value.descriptor : null,
        direction: value.direction === 'outbound' || value.direction === 'inbound' ? value.direction : null,
        functionName: typeof value.function === 'string' ? value.function : null,
        requestedLength: Number.isFinite(value.requestedLength) ? value.requestedLength : null,
        actualLength: Number.isFinite(value.actualLength) ? value.actualLength : null,
        hasPreview: typeof value.previewHex === 'string' && value.previewHex.length > 0
    };
}

function minimum(values) {
    return values.length === 0 ? null : Math.min(...values);
}

function maximum(values) {
    return values.length === 0 ? null : Math.max(...values);
}

function median(values) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function durationSeconds(timestamps) {
    if (timestamps.length < 2) {
        return null;
    }
    return (Math.max(...timestamps) - Math.min(...timestamps)) / 1000;
}

function ownershipConsistent(ownership) {
    if (ownership.length === 0) {
        return false;
    }
    const first = ownership[0];
    return ownership.every(entry => entry.processId === first.processId && entry.uid === first.uid && entry.package === first.package);
}

function endpointConfidence(record) {
    const hasProcessOwnership = record.processOwnership.length > 0;
    const hasFridaData = record.fridaEventCount > 0;
    if (hasProcessOwnership && hasFridaData && record.outboundEvents > 0 && record.inboundEvents > 0) {
        return 'medium';
    }
    if (hasProcessOwnership || hasFridaData) {
        return 'low';
    }
    return 'insufficient';
}

function buildEndpointResult(record) {
    const sortedTimestamps = [...record.timestamps].sort((left, right) => left - right);
    return {
        endpoint: record.endpoint,
        classification: record.classification,
        confidence: endpointConfidence(record),
        provenGateway: false,
        sources: [...record.sources].sort(),
        observedPhases: [...record.observedPhases].sort(),
        states: [...record.states].sort(),
        descriptors: [...record.descriptors].sort((left, right) => left - right),
        processOwnershipConsistent: ownershipConsistent(record.processOwnership),
        socketSnapshotCount: record.socketSnapshotCount,
        fridaEventCount: record.fridaEventCount,
        directions: [...record.directions].sort(),
        functions: [...record.functions].sort(),
        outboundEvents: record.outboundEvents,
        inboundEvents: record.inboundEvents,
        requestedLength: {
            count: record.requestedLengths.length,
            minimum: minimum(record.requestedLengths),
            median: median(record.requestedLengths),
            maximum: maximum(record.requestedLengths)
        },
        actualLength: {
            count: record.actualLengths.length,
            minimum: minimum(record.actualLengths),
            median: median(record.actualLengths),
            maximum: maximum(record.actualLengths)
        },
        observedInterval: sortedTimestamps.length === 0 ? null : {
            start: new Date(sortedTimestamps[0]).toISOString(),
            end: new Date(sortedTimestamps[sortedTimestamps.length - 1]).toISOString(),
            durationSeconds: durationSeconds(sortedTimestamps)
        }
    };
}

function flowGate(flow, endpointResults, outboundEvents, inboundEvents) {
    const evidence = {
        endpointCount: endpointResults.length,
        bidirectionalEvidence: outboundEvents > 0 && inboundEvents > 0,
        processOwnership: endpointResults.some(endpoint => endpoint.processOwnershipConsistent),
        repeatedFridaEvidence: (outboundEvents + inboundEvents) >= 3
    };
    return {
        flow,
        status: evidence.bidirectionalEvidence && evidence.processOwnership && evidence.repeatedFridaEvidence
            ? 'needs-semantic-confirmation'
            : 'insufficient',
        evidence,
        unresolved: [
            'numeric command ID',
            'frame boundary',
            'encryption or compression boundary',
            'semantic response timing'
        ]
    };
}

function validateAnchorCatalog(catalog) {
    if (!catalog || catalog.version !== 1) {
        throw new Error('Anchor catalog version must be 1');
    }
    for (const list of ['staticEvidence', 'semanticAnchors']) {
        if (!Array.isArray(catalog[list])) {
            throw new Error(`Anchor catalog ${list} must be an array`);
        }
        for (const anchor of catalog[list]) {
            if (!anchor.name || typeof anchor.name !== 'string') {
                throw new Error('Anchor name is required');
            }
            if (!['high', 'medium', 'low'].includes(anchor.confidence)) {
                throw new Error(`Anchor confidence must be high, medium, or low: ${anchor.name}`);
            }
        }
    }
}

function renderMarkdown(result) {
    const lines = [];
    lines.push('# Protocol capture findings');
    lines.push('');
    lines.push(`Generated: ${result.generatedAt}`);
    lines.push('');
    lines.push('This report merges process-owned socket observations and Frida socket events. It records endpoint, direction, and length evidence only. It does not infer frame headers, command IDs, encryption, compression, or schemas from static names or byte previews.');
    lines.push('');
    lines.push('## Evidence status');
    lines.push('');
    lines.push(`- Process-socket snapshots: **${result.input.processSocketSnapshots}**`);
    lines.push(`- Process-owned connections: **${result.input.processOwnedConnections}**`);
    lines.push(`- Frida files: **${result.input.fridaFiles}**`);
    lines.push(`- Frida events: **${result.input.fridaEvents}**`);
    lines.push(`- Outbound socket events: **${result.input.fridaOutboundEvents}**`);
    lines.push(`- Inbound socket events: **${result.input.fridaInboundEvents}**`);
    lines.push(`- Evidence completeness: **${result.evidenceStatus}**`);
    lines.push('');
    lines.push('Raw byte previews are not copied into this report. They remain only in local capture files.');
    lines.push('');
    lines.push('## Endpoint evidence');
    lines.push('');
    lines.push('The `game-candidate` label means only that the endpoint is non-HTTP and process/socket or Frida evidence observed it. It is not a proven game gateway.');
    lines.push('');
    lines.push('| Endpoint | Sources | Classification | Confidence | Out / In | Actual length range | Phase |');
    lines.push('| --- | --- | --- | --- | ---: | --- | --- |');
    for (const endpoint of result.endpoints) {
        const name = `${endpoint.endpoint.address}:${endpoint.endpoint.port}`;
        const length = endpoint.actualLength.count === 0
            ? 'n/a'
            : `${endpoint.actualLength.minimum}–${endpoint.actualLength.maximum}`;
        lines.push(`| ${name} | ${endpoint.sources.join(', ')} | ${endpoint.classification} | ${endpoint.confidence} | ${endpoint.outboundEvents} / ${endpoint.inboundEvents} | ${length} | ${endpoint.observedPhases.join(', ') || 'unlabeled'} |`);
    }
    lines.push('');
    lines.push('## Protocol findings');
    lines.push('');
    lines.push('| Finding | Status | Evidence restriction |');
    lines.push('| --- | --- | --- |');
    for (const finding of result.findings) {
        lines.push(`| ${finding.name} | ${finding.status} | ${finding.reason} |`);
    }
    lines.push('');
    lines.push('## Flow gates');
    lines.push('');
    lines.push('| Flow | Status | Bidirectional | Process-owned | Repeated socket evidence |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const gate of result.flowGates) {
        lines.push(`| ${gate.flow} | ${gate.status} | ${gate.evidence.bidirectionalEvidence} | ${gate.evidence.processOwnership} | ${gate.evidence.repeatedFridaEvidence} |`);
    }
    lines.push('');
    lines.push('A `needs-semantic-confirmation` gate still cannot pass: every flow requires consistent command grouping and a response-before-state-change sequence. No flow is complete in this report unless those conditions and the runbook gates are explicitly added.');
    lines.push('');
    lines.push('## Static anchor correlation');
    lines.push('');
    lines.push('Static anchors are listed as correlation targets. Correlation requires runtime call stacks, matching phases, and socket events; it is not established merely because a capture exists.');
    lines.push('');
    lines.push('| Flow / role | Anchor | Static confidence | Dynamic correlation |');
    lines.push('| --- | --- | --- | --- |');
    for (const anchor of result.anchorCatalog.semanticAnchors) {
        lines.push(`| ${anchor.flow} | ${anchor.name} | ${anchor.confidence} | not correlated |`);
    }
    for (const anchor of result.anchorCatalog.staticEvidence) {
        const role = `${anchor.library} ${anchor.kind}: ${anchor.correlationRole}`;
        lines.push(`| ${role} | ${anchor.name} | ${anchor.confidence} | not correlated |`);
    }
    lines.push('');
    lines.push('## Data quality');
    lines.push('');
    for (const warning of result.dataQuality.warnings) {
        lines.push(`- ${warning}`);
    }
    if (result.dataQuality.invalidJsonLines === 0) {
        lines.push('- No invalid Frida JSONL lines were detected.');
    } else {
        lines.push(`- Invalid Frida JSONL lines: **${result.dataQuality.invalidJsonLines}**.`);
    }
    lines.push('');
    lines.push('## Current blockers');
    lines.push('');
    for (const blocker of result.blockers) {
        lines.push(`- ${blocker}`);
    }
    lines.push('');
    return lines.join('\n');
}

async function loadInputs(collector) {
    const socketFileGroups = await Promise.all(command.sockets.map(directory => listFiles(directory, ['.json'])));
    const fridaFileGroups = await Promise.all(command.frida.map(directory => listFiles(directory, ['.jsonl'])));
    const socketFiles = socketFileGroups.flat();
    const fridaFiles = fridaFileGroups.flat();

    for (const filePath of socketFiles) {
        const documentValue = await loadJsonObject(filePath);
        const snapshot = parseSocketSnapshot(documentValue, filePath);
        snapshot.sha256 = await hashFile(filePath);
        collector.socketSnapshots.push(snapshot);
        for (const connectionValue of documentValue.connections) {
            const connection = parseSocketConnection(connectionValue, snapshot);
            if (!connection) {
                continue;
            }
            collector.socketConnections.push(connection);
            recordEndpoint(collector, connection.endpoint, 'process-socket', {
                timestamp: connection.capturedAt,
                state: connection.state,
                descriptor: connection.inode,
                phase: 'unlabeled',
                processOwnership: {
                    package: snapshot.package,
                    processId: snapshot.processId,
                    uid: snapshot.uid
                }
            });
        }
    }

    for (const filePath of fridaFiles) {
        const parser = {
            invalid: []
        };
        const stats = await stat(filePath);
        const load = await loadJsonl(filePath, parser.invalid, (value, source, line) => {
            const event = parseFridaEvent(value, source, line);
            collector.fridaEvents.push(event);
            if (event.endpoint) {
                recordEndpoint(collector, event.endpoint, 'frida', {
                    timestamp: event.timestamp,
                    descriptor: event.descriptor,
                    state: null,
                    phase: event.phase,
                    direction: event.direction,
                    functionName: event.functionName,
                    actualLength: event.actualLength,
                    requestedLength: event.requestedLength
                });
            }
        });
        parser.invalid.forEach(error => collector.invalid.push(error));
        collector.fridaFiles.push({
            source: filePath,
            sha256: await hashFile(filePath),
            sizeBytes: stats.size,
            eventCount: load.events,
            invalidLineCount: load.invalidLines,
            phase: inferPhase(filePath)
        });
    }
}

async function main() {
    parseArguments(process.argv.slice(2));
    const collector = createCollector();
    await loadInputs(collector);

    const anchorCatalog = await loadJsonObject(command.anchors);
    validateAnchorCatalog(anchorCatalog);

    const endpointResults = [...collector.endpoints.values()]
        .map(buildEndpointResult)
        .sort((left, right) => endpointKey(left.endpoint).localeCompare(endpointKey(right.endpoint)));

    const outboundEvents = collector.fridaEvents.filter(event => event.direction === 'outbound' && event.type === 'socket-data').length;
    const inboundEvents = collector.fridaEvents.filter(event => event.direction === 'inbound' && event.type === 'socket-data').length;
    const processOwnedConnections = collector.socketConnections.length;
    const evidenceStatus = outboundEvents > 0 || inboundEvents > 0 || processOwnedConnections > 0
        ? 'insufficient-for-protocol-recovery'
        : 'no-dynamic-evidence';

    const warnings = [];
    if (collector.socketSnapshots.length === 0) {
        warnings.push('No process-socket snapshots were supplied; endpoint ownership is unavailable.');
    }
    if (collector.fridaFiles.length === 0) {
        warnings.push('No Frida JSONL captures were supplied; socket byte direction and lengths are unavailable.');
    }
    if (outboundEvents === 0 || inboundEvents === 0) {
        warnings.push('At least one socket direction is missing; bidirectional framing cannot be evaluated.');
    }
    if (collector.fridaEvents.some(event => event.phase === 'unlabeled')) {
        warnings.push('At least one Frida file has no recognized UI phase in its filename.');
    }
    if (collector.fridaEvents.length > 0 && collector.fridaEvents.every(event => !event.hasPreview)) {
        warnings.push('No socket event retained a byte preview; boundary correlation is impossible.');
    }
    if (collector.invalid.length > 0) {
        warnings.push(`Capture parsing encountered ${collector.invalid.length} invalid JSONL line(s).`);
    }

    const result = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        evidenceStatus,
        input: {
            processSocketSnapshots: collector.socketSnapshots.length,
            processOwnedConnections,
            fridaFiles: collector.fridaFiles.length,
            fridaEvents: collector.fridaEvents.length,
            fridaOutboundEvents: outboundEvents,
            fridaInboundEvents: inboundEvents,
            socketSnapshots: collector.socketSnapshots,
            fridaFiles: collector.fridaFiles
        },
        endpoints: endpointResults,
        findings: [
            {
                name: 'Gateway endpoint',
                status: 'not proven',
                reason: 'A non-HTTP endpoint is only a candidate; repeated process-owned observations or a runtime connect backtrace is required.'
            },
            {
                name: 'Frame boundary',
                status: 'not recovered',
                reason: 'Only observed socket read/write lengths are recorded; no header interpretation is permitted without managed pack/unpack evidence.'
            },
            {
                name: 'Direction evidence',
                status: outboundEvents > 0 || inboundEvents > 0 ? 'partial' : 'absent',
                reason: 'Directions come only from hooked socket calls and are not semantic request/response labels.'
            },
            {
                name: 'Length evidence',
                status: collector.fridaEvents.some(event => Number.isFinite(event.actualLength) && event.actualLength > 0) ? 'partial' : 'absent',
                reason: 'Lengths are syscall results and may contain partial frames, coalesced frames, or non-protocol bytes.'
            },
            {
                name: 'Command ID',
                status: 'not recovered',
                reason: 'The static commandId field is not mapped to bytes or numeric values.'
            },
            {
                name: 'Encryption / compression',
                status: 'not recovered',
                reason: 'No pre-cipher and post-cipher buffers, compression boundary, or repeated call-chain evidence is present.'
            }
        ],
        flowGates: [
            flowGate('account', endpointResults, outboundEvents, inboundEvents),
            flowGate('battle', endpointResults, outboundEvents, inboundEvents),
            flowGate('shop', endpointResults, outboundEvents, inboundEvents)
        ],
        anchorCatalog,
        dataQuality: {
            invalidJsonLines: collector.invalid.length,
            invalidJsonLineSamples: collector.invalid.slice(0, 10),
            warnings
        },
        blockers: [
            'No numeric message-ID registry is proven.',
            'No complete frame header, length layout, sequence layout, or command encoding is proven.',
            'No pre/post encryption or compression boundary is proven.',
            'No runtime backtrace connects a socket call to a managed connector, pack-buffer export, or semantic message handler.',
            'No account, battle, or shop response-before-state-change sequence is proven.'
        ]
    };

    await mkdir(path.dirname(command.output), {
        recursive: true
    });
    await writeFile(command.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await mkdir(path.dirname(command.markdown), {
        recursive: true
    });
    await writeFile(command.markdown, renderMarkdown(result), 'utf8');
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
