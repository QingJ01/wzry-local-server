'use strict';

/*
 * Dynamic capture matrix evaluator.
 *
 * Reads process-socket snapshots, Frida captures, and HTTP observation files from the
 * configured evidence directories, groups them into UI phases, and reports how many
 * complete rounds each phase has and which gate conditions are met.
 *
 * This tool only indexes and evaluates evidence. It never touches a device, never
 * modifies a capture, and never asserts that a protocol field is proven. A phase is
 * "complete" only when its runbook gate conditions are met across the required number
 * of independent rounds; otherwise it is reported as "insufficient" or "in-progress".
 */

import {
    createReadStream,
    readFileSync,
    readdirSync,
    statSync
} from 'node:fs';
import {
    createInterface
} from 'node:readline';
import path from 'node:path';
import {
    fileURLToPath
} from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const command = {
    config: fileURLToPath(new URL('./config/capture_matrix.json', import.meta.url)),
    sockets: null,
    frida: null,
    http: null,
    output: null,
    markdown: null
};

function parseArguments(argv) {
    const options = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!['--config', '--sockets', '--frida', '--http', '--output', '--markdown'].includes(argument)) {
            throw new Error(`Unknown argument: ${argument}`);
        }
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for ${argument}`);
        }
        if (options.has(argument)) {
            throw new Error(`Argument repeated: ${argument}`);
        }
        options.set(argument, value);
    }
    command.config = options.get('--config') ?? command.config;
    command.sockets = options.get('--sockets') ?? null;
    command.frida = options.get('--frida') ?? null;
    command.http = options.get('--http') ?? null;
    command.output = options.get('--output') ?? null;
    command.markdown = options.get('--markdown') ?? null;
}

async function loadConfig() {
    const resolved = path.resolve(command.config);
    const raw = await import('node:fs/promises').then(fs => fs.readFile(resolved, 'utf8'));
    const value = JSON.parse(raw.toString().replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || value.version !== 1) {
        throw new Error(`Capture matrix config version must be 1: ${resolved}`);
    }
    if (!Array.isArray(value.phases)) {
        throw new Error('Capture matrix config must contain a phases array');
    }
    return value;
}

function listFiles(root, extensions) {
    let entries;
    try {
        entries = readdirSync(root, {
            withFileTypes: true
        });
    } catch {
        return [];
    }
    const files = [];
    for (const entry of entries) {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFiles(entryPath, extensions));
        } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
            files.push(entryPath);
        }
    }
    return files.sort();
}

/*
 * Returns the UI phase encoded in a filename, or 'unlabeled'. The phase must appear
 * as a filename prefix or a `-<phase>-`/`-<phase>` token so that observation files
 * such as `01-login-page.json` or `post-consent-...-login.ndjson` are attributed to
 * the correct matrix phase rather than guessed from content.
 */
const KNOWN_PHASES = ['cold-start', 'login', 'lobby', 'room', 'battle', 'shop', 'settlement', 'consent', 'first-screen'];

function inferPhase(filePath) {
    const name = path.basename(filePath).toLowerCase();
    for (const phase of KNOWN_PHASES) {
        if (name.startsWith(`${phase}-`) || name === `${phase}.json` || name.includes(`-${phase}-`) || name.includes(`-${phase}.`)) {
            return phase;
        }
    }
    for (const phase of KNOWN_PHASES) {
        if (name.includes(phase)) {
            return phase;
        }
    }
    return 'unlabeled';
}

/*
 * Normalize an endpoint address for display/dedup: collapse IPv4-mapped IPv6
 * forms (`::ffff:a.b.c.d` and the hex `0:0:0:0:0:ffff:XXYY:ZZWW`) to dotted
 * IPv4, and mark loopback. Returns { text, loopback }.
 */
function normalizeEndpointAddress(address) {
    const text = String(address || '');
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
    if (mapped) {
        return { text: mapped[1], loopback: mapped[1] === '127.0.0.1' };
    }
    const hexMapped = /^0*:0*:0*:0*:0*:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(text);
    if (hexMapped) {
        const high = Number.parseInt(hexMapped[1], 16);
        const low = Number.parseInt(hexMapped[2], 16);
        const ipv4 = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
        return { text: ipv4, loopback: ipv4 === '127.0.0.1' };
    }
    return { text, loopback: text === '127.0.0.1' || text === '::1' };
}

function parseEpoch(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1e12 ? value : value * 1000;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function unwrapFridaMessage(value) {
    if (value && typeof value === 'object' &&
        value.message && typeof value.message === 'object' &&
        value.message.type === 'send' &&
        value.message.payload && typeof value.message.payload === 'object') {
        return value.message.payload;
    }
    return value;
}

async function readJsonl(filePath, onEvent) {
    const stream = createReadStream(filePath, {
        encoding: 'utf8'
    });
    const reader = createInterface({
        input: stream,
        crlfDelay: Infinity
    });
    let events = 0;
    let invalid = 0;
    for await (const line of reader) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const value = JSON.parse(trimmed);
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error('JSONL event is not an object');
            }
            onEvent(value);
            events += 1;
        } catch {
            invalid += 1;
        }
    }
    return {
        events,
        invalid
    };
}

function analyzeFridaFile(filePath) {
    const file = {
        source: path.relative(projectRoot, filePath),
        phase: inferPhase(filePath),
        sizeBytes: statSync(filePath).size,
        events: 0,
        invalidLines: 0,
        sessionStarted: false,
        hookAttached: 0,
        hookMissing: 0,
        connectEvents: 0,
        socketEvents: 0,
        socketDataEvents: 0,
        outboundEvents: 0,
        inboundEvents: 0,
        networkConnects: 0,
        non443Connects: 0,
        endpoints: new Set(),
        non443Endpoints: new Set(),
        dataEndpoints: new Set(),
        inodes: new Set(),
        descriptors: new Set(),
        firstTimestamp: null,
        lastTimestamp: null,
        hasSocketData: false
    };

    return readJsonl(filePath, raw => {
        const value = unwrapFridaMessage(raw);
        const timestamp = parseEpoch(value.timestamp) ?? parseEpoch(raw.timestamp);
        if (timestamp !== null) {
            if (file.firstTimestamp === null || timestamp < file.firstTimestamp) {
                file.firstTimestamp = timestamp;
            }
            if (file.lastTimestamp === null || timestamp > file.lastTimestamp) {
                file.lastTimestamp = timestamp;
            }
        }
        if (Number.isInteger(value.socketInode)) {
            file.inodes.add(value.socketInode);
        }
        if (Number.isInteger(value.descriptor)) {
            file.descriptors.add(value.descriptor);
        }
        const endpoint = value.endpoint && typeof value.endpoint === 'object' ? value.endpoint : null;
        if (endpoint && endpoint.address && Number.isInteger(endpoint.port)) {
            const normalized = normalizeEndpointAddress(endpoint.address);
            file.endpoints.add(`${normalized.text}:${endpoint.port}`);
        }
        switch (value.type) {
            case 'session-started':
                file.sessionStarted = true;
                break;
            case 'hook-attached':
                file.hookAttached += 1;
                break;
            case 'hook-missing':
                file.hookMissing += 1;
                break;
            case 'socket':
                file.socketEvents += 1;
                break;
            case 'connect':
                file.connectEvents += 1;
                if (value.network === true) {
                    file.networkConnects += 1;
                    const normalized = endpoint && endpoint.address ? normalizeEndpointAddress(endpoint.address) : null;
                    if (endpoint && Number.isInteger(endpoint.port) && endpoint.port !== 443 && endpoint.port !== 80 &&
                        normalized && !normalized.loopback) {
                        file.non443Connects += 1;
                        file.non443Endpoints.add(`${normalized.text}:${endpoint.port}`);
                    }
                }
                break;
            case 'socket-data':
                file.socketDataEvents += 1;
                file.hasSocketData = true;
                if (endpoint && endpoint.address) {
                    const normalized = normalizeEndpointAddress(endpoint.address);
                    file.dataEndpoints.add(`${normalized.text}:${endpoint.port}`);
                }
                if (value.direction === 'outbound') {
                    file.outboundEvents += 1;
                } else if (value.direction === 'inbound') {
                    file.inboundEvents += 1;
                }
                break;
            default:
                break;
        }
    }).then(counts => {
        file.events = counts.events;
        file.invalidLines = counts.invalid;
        file.endpoints = [...file.endpoints].sort();
        file.non443Endpoints = [...file.non443Endpoints].sort();
        file.dataEndpoints = [...file.dataEndpoints].sort();
        file.inodes = [...file.inodes].sort((a, b) => a - b);
        file.descriptors = [...file.descriptors].sort((a, b) => a - b);
        return file;
    });
}

function readSmallJson(filePath) {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function analyzeSocketSnapshot(filePath) {
    let value;
    try {
        if (statSync(filePath).size === 0) {
            return null;
        }
        value = readSmallJson(filePath);
    } catch {
        return null;
    }
    return buildSocketSnapshot(value, filePath);
}

function buildSocketSnapshot(value, filePath) {
    const connections = Array.isArray(value.connections) ? value.connections : [];
    const sockets = Array.isArray(value.sockets) ? value.sockets : [];
    const file = {
        source: path.relative(projectRoot, filePath),
        phase: inferPhase(filePath),
        capturedAt: parseEpoch(value.capturedAt),
        processId: parseIntOrNull(value.processId),
        uid: parseIntOrNull(value.uid),
        socketInodes: sockets
            .map(entry => parseIntOrNull(entry.Inode ?? entry.inode))
            .filter(v => v !== null),
        connections: connections
            .map(connection => ({
                inode: parseIntOrNull(connection.Inode ?? connection.inode),
                remote: connection.RemoteAddress ?? connection.remoteAddress ?? null,
                state: connection.State ?? connection.state ?? null,
                uid: parseIntOrNull(connection.Uid ?? connection.uid)
            }))
            .filter(connection => connection.inode !== null),
        ownedConnectionCount: 0
    };
    const inodeSet = new Set(file.socketInodes);
    file.ownedConnectionCount = file.connections.filter(connection => inodeSet.has(connection.inode)).length;
    return file;
}

function parseIntOrNull(value) {
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
}

function analyzeHttpObservation(filePath) {
    let value;
    try {
        value = readSmallJson(filePath);
    } catch {
        return null;
    }
    if (!Array.isArray(value)) {
        // Tolerate both a bare observation array and the export wrapper
        // `{ "observations": [...] }` produced by the local server exporter.
        if (value && typeof value === 'object' && Array.isArray(value.observations)) {
            value = value.observations;
        } else {
            return null;
        }
    }
    const file = {
        source: path.relative(projectRoot, filePath),
        phase: inferPhase(filePath),
        records: value.length,
        statusCounts: {},
        methodIds: new Map(),
        firstUnixMs: null,
        lastUnixMs: null
    };
    for (const record of value) {
        if (record && typeof record === 'object') {
            const status = String(record.status ?? 'unknown');
            file.statusCounts[status] = (file.statusCounts[status] ?? 0) + 1;
            if (Number.isInteger(record.methodId)) {
                const bucket = file.methodIds.get(record.methodId) ?? { count: 0, statuses: new Set(), bytes: new Set() };
                bucket.count += 1;
                bucket.statuses.add(record.status ?? 'unknown');
                if (Number.isFinite(record.bytes)) {
                    bucket.bytes.add(record.bytes);
                }
                file.methodIds.set(record.methodId, bucket);
            }
            const ts = parseEpoch(record.recordedAtUnixMs);
            if (ts !== null) {
                if (file.firstUnixMs === null || ts < file.firstUnixMs) {
                    file.firstUnixMs = ts;
                }
                if (file.lastUnixMs === null || ts > file.lastUnixMs) {
                    file.lastUnixMs = ts;
                }
            }
        }
    }
    return file;
}

/*
 * Candidate evidence rows summarize the strongest protocol-adjacent signals in the
 * evidence set without asserting recovery: non-443 endpoints, endpoints that carry
 * real socket bytes, and HTTP methodId observations from the local server's 501
 * frame channel. Each row reports which evidence classes are still missing.
 */
function buildCandidateEvidence(fridaFiles, socketFiles, httpFiles) {
    const candidates = [];

    const endpointStats = new Map();
    for (const file of fridaFiles) {
        // Only non-443 network connects become endpoint candidates; data-byte
        // presence is decided per endpoint via dataEndpoints, not file totals.
        for (const endpoint of file.non443Endpoints) {
            const entry = endpointStats.get(endpoint) ?? {
                endpoint,
                phases: new Set(),
                files: 0,
                hasData: false
            };
            entry.phases.add(file.phase);
            entry.files += 1;
            if (file.dataEndpoints.includes(endpoint)) {
                entry.hasData = true;
            }
            endpointStats.set(endpoint, entry);
        }
    }
    for (const entry of endpointStats.values()) {
        const missing = [];
        if (!entry.hasData) {
            missing.push('socket bytes on this endpoint');
        }
        missing.push('process-owned inode match', 'repeat across sessions');
        candidates.push({
            kind: 'endpoint',
            subject: entry.endpoint,
            phases: [...entry.phases].sort().join(', '),
            strength: `connect observed${entry.hasData ? ' + data bytes' : ''}`,
            missing: missing.filter(Boolean).join('; '),
            status: 'candidate'
        });
    }

    for (const file of httpFiles) {
        for (const [methodId, bucket] of file.methodIds) {
            candidates.push({
                kind: 'http-methodId',
                subject: `methodId ${methodId}`,
                phases: file.phase,
                strength: `${bucket.count} obs, status ${[...bucket.statuses].sort().join('/')}, bytes ${[...bucket.bytes].sort((a, b) => a - b).join('/')}`,
                missing: 'request path/body; wire command mapping; client-side origin',
                status: 'observed-501'
            });
        }
    }

    return candidates.sort((left, right) => left.subject.localeCompare(right.subject));
}

function buildEvidenceGaps(phases, fridaFiles, socketFiles, httpFiles) {
    const gaps = [];
    const totalSocketData = fridaFiles.reduce((sum, f) => sum + f.socketDataEvents, 0);
    const non443Endpoints = new Set();
    for (const file of fridaFiles) {
        for (const endpoint of file.non443Endpoints) {
            non443Endpoints.add(endpoint);
        }
    }
    const methodIds = new Set();
    for (const file of httpFiles) {
        for (const methodId of file.methodIds.keys()) {
            methodIds.add(methodId);
        }
    }

    if (!socketFiles.some(s => s.ownedConnectionCount > 0 && s.phase !== 'unlabeled')) {
        gaps.push('No phase-tagged process-owned socket snapshot; endpoint ownership cannot be tied to a UI phase.');
    }
    const silentNon443 = [...non443Endpoints].filter(e => fridaFiles.every(f => !f.dataEndpoints.includes(e)));
    if (non443Endpoints.size === 0) {
        gaps.push('No non-443 endpoint observed at all; game gateway location is unknown.');
    } else if (silentNon443.length > 0) {
        gaps.push(`Non-443 endpoint(s) ${silentNon443.join(', ')} observed only at connect level; no socket bytes recorded on them.`);
    }
    if (methodIds.size > 0) {
        gaps.push(`HTTP 501 methodId(s) ${[...methodIds].sort((a, b) => a - b).join(', ')} recorded by the local server; their wire encoding, request path, and client origin are unproven.`);
    }
    if (phases.every(p => p.completedRounds === 0)) {
        gaps.push('No phase completed a single gate round; phase-correlated capture is still the primary gap.');
    }
    gaps.push('No runtime backtrace ties any socket call to a managed connector or pack-buffer export.');
    gaps.push('No response-before-state-change sequence recorded for account, shop, or battle flows.');
    return gaps;
}

/*
 * Group artifacts into independent capture rounds. A round is a set of artifacts
 * whose timestamps overlap or are adjacent within `roundGapMs`. Socket snapshots
 * and Frida captures recorded close together are treated as one round so a phase is
 * only credited once per real session.
 */
const roundGapMs = 120000;

function buildRounds(artifacts) {
    const timed = artifacts
        .filter(a => a.sortKey !== null)
        .sort((a, b) => a.sortKey - b.sortKey);
    const rounds = [];
    let current = null;
    for (const artifact of timed) {
        if (current === null || artifact.sortKey - current.end > roundGapMs) {
            current = {
                start: artifact.sortKey,
                end: artifact.sortKey,
                artifacts: []
            };
            rounds.push(current);
        }
        current.end = Math.max(current.end, artifact.sortKey);
        current.artifacts.push(artifact);
    }
    return rounds;
}

function evaluatePhase(definition, fridaFiles, socketFiles, httpFiles) {
    const artifacts = [];
    for (const file of fridaFiles) {
        artifacts.push({
            kind: 'frida',
            sortKey: file.firstTimestamp,
            file
        });
    }
    for (const file of socketFiles) {
        artifacts.push({
            kind: 'sockets',
            sortKey: file.capturedAt,
            file
        });
    }
    for (const file of httpFiles) {
        artifacts.push({
            kind: 'http',
            sortKey: file.firstUnixMs,
            file
        });
    }

    const rounds = buildRounds(artifacts);
    const gate = definition.gate || {};

    const roundEvaluations = rounds.map(round => {
        const frida = round.artifacts.filter(a => a.kind === 'frida').map(a => a.file);
        const sockets = round.artifacts.filter(a => a.kind === 'sockets').map(a => a.file);
        const http = round.artifacts.filter(a => a.kind === 'http').map(a => a.file);

        const allInodes = new Set(sockets.flatMap(s => s.socketInodes));
        const owned = sockets.reduce((sum, s) => sum + s.ownedConnectionCount, 0);
        const outbound = frida.reduce((sum, f) => sum + f.outboundEvents, 0);
        const inbound = frida.reduce((sum, f) => sum + f.inboundEvents, 0);
        const non443 = frida.reduce((sum, f) => sum + f.non443Connects, 0);
        const sessionStarted = frida.some(f => f.sessionStarted);

        const processOwnership = owned > 0 && allInodes.size > 0;
        const bidirectional = outbound > 0 && inbound > 0;
        const repeatedEndpoint = non443 > 0;
        const hasSocketSnapshot = sockets.length >= (gate.minSocketSnapshotsPerRound ?? 1);

        const checks = {
            processOwnership: gate.requiresProcessOwnership ? processOwnership : true,
            bidirectional: gate.requiresBidirectionalData ? bidirectional : true,
            repeatedEndpoint: gate.requiresRepeatedEndpoint ? repeatedEndpoint : true,
            socketSnapshot: hasSocketSnapshot,
            sessionStarted
        };
        const complete = checks.processOwnership && checks.bidirectional &&
            checks.repeatedEndpoint && checks.socketSnapshot && checks.sessionStarted;

        return {
            start: new Date(round.start).toISOString(),
            end: new Date(round.end).toISOString(),
            artifacts: round.artifacts.map(a => `${a.kind}:${a.file.source}`),
            fridaFiles: frida.length,
            socketSnapshots: sockets.length,
            httpFiles: http.length,
            ownedConnections: owned,
            outboundEvents: outbound,
            inboundEvents: inbound,
            non443Connects: non443,
            checks,
            complete
        };
    });

    const completedRounds = roundEvaluations.filter(r => r.complete).length;
    const status = completedRounds >= definition.minRounds ? 'complete'
        : roundEvaluations.length > 0 ? 'in-progress'
        : 'pending';

    return {
        phase: definition.phase,
        order: definition.order,
        minRounds: definition.minRounds,
        completedRounds,
        observedRounds: roundEvaluations.length,
        status,
        description: definition.description,
        gateNotes: definition.gate?.notes ?? null,
        rounds: roundEvaluations
    };
}

function renderMarkdown(result) {
    const lines = [];
    lines.push('# Dynamic capture matrix');
    lines.push('');
    lines.push(`Generated: ${result.generatedAt}`);
    lines.push('');
    lines.push('This report indexes observed capture rounds per UI phase and evaluates them against the runbook gates. A phase is **complete** only when its minimum rounds are met with process-owned, bidirectional, phase-specific evidence. Nothing here asserts a protocol field is proven.');
    lines.push('');
    lines.push('## Phase status');
    lines.push('');
    lines.push('| Phase | Min rounds | Observed rounds | Complete rounds | Status |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const phase of result.phases) {
        lines.push(`| ${phase.phase} | ${phase.minRounds} | ${phase.observedRounds} | ${phase.completedRounds} | ${phase.status} |`);
    }
    lines.push('');
    lines.push('## Round detail');
    lines.push('');
    for (const phase of result.phases) {
        lines.push(`### ${phase.phase}`);
        lines.push('');
        if (phase.gateNotes) {
            lines.push(`Gate: ${phase.gateNotes}`);
            lines.push('');
        }
        if (phase.rounds.length === 0) {
            lines.push('- No observed rounds yet.');
            lines.push('');
            continue;
        }
        lines.push('| Round window | Artifacts | Owned conns | Out / In | Non-443 connects | Checks | Complete |');
        lines.push('| --- | --- | ---: | --- | ---: | --- | --- |');
        for (const round of phase.rounds) {
            const checks = Object.entries(round.checks)
                .filter(([, ok]) => ok)
                .map(([name]) => name)
                .join(', ') || 'none';
            lines.push(`| ${round.start} – ${round.end} | ${round.artifacts.length} | ${round.ownedConnections} | ${round.outboundEvents} / ${round.inboundEvents} | ${round.non443Connects} | ${checks} | ${round.complete} |`);
        }
        lines.push('');
    }
    lines.push('## Evidence index');
    lines.push('');
    lines.push('| Kind | File | Phase | Events / Records | Notes |');
    lines.push('| --- | --- | --- | ---: | --- |');
    for (const entry of result.evidenceIndex) {
        lines.push(`| ${entry.kind} | ${entry.source} | ${entry.phase} | ${entry.count} | ${entry.notes} |`);
    }
    lines.push('');
    lines.push('## Candidate evidence');
    lines.push('');
    lines.push('Candidate rows index the strongest protocol-adjacent signals observed so far. They are correlation targets, not proven fields; a `candidate` or `observed-501` status asserts observation only.');
    lines.push('');
    if (result.candidateEvidence.length === 0) {
        lines.push('- No candidate endpoints or methodId observations recorded yet.');
    } else {
        lines.push('| Kind | Subject | Phase | Strength | Missing | Status |');
        lines.push('| --- | --- | --- | --- | --- | --- |');
        for (const candidate of result.candidateEvidence) {
            lines.push(`| ${candidate.kind} | ${candidate.subject} | ${candidate.phases} | ${candidate.strength} | ${candidate.missing} | ${candidate.status} |`);
        }
    }
    lines.push('');
    lines.push('## Evidence gaps');
    lines.push('');
    for (const gap of result.evidenceGaps) {
        lines.push(`- ${gap}`);
    }
    lines.push('');
    lines.push('## Blockers');
    lines.push('');
    for (const blocker of result.blockers) {
        lines.push(`- ${blocker}`);
    }
    lines.push('');
    return lines.join('\n');
}

async function main() {
    parseArguments(process.argv.slice(2));
    const config = await loadConfig();

    const socketsDir = command.sockets ?? path.join(projectRoot, config.evidenceDirectories.sockets);
    const fridaDir = command.frida ?? path.join(projectRoot, config.evidenceDirectories.frida);
    const httpDir = command.http ?? path.join(projectRoot, config.evidenceDirectories.http);

    const socketFiles = listFiles(socketsDir, ['.json'])
        .map(analyzeSocketSnapshot)
        .filter(Boolean);
    const fridaFiles = await Promise.all(
        listFiles(fridaDir, ['.jsonl', '.ndjson'])
        .filter(f => !f.endsWith('.metadata.json'))
        .map(analyzeFridaFile)
    );
    const httpFiles = listFiles(httpDir, ['.json'])
        .filter(f => path.basename(f).includes('http'))
        .map(analyzeHttpObservation)
        .filter(Boolean);

    const phases = config.phases
        .slice()
        .sort((a, b) => a.order - b.order)
        .map(definition => evaluatePhase(
            definition,
            fridaFiles.filter(f => f.phase === definition.phase),
            socketFiles.filter(f => f.phase === definition.phase),
            httpFiles.filter(f => f.phase === definition.phase)
        ));

    const evidenceIndex = [];
    for (const file of fridaFiles) {
        evidenceIndex.push({
            kind: 'frida',
            source: file.source,
            phase: file.phase,
            count: file.events,
            notes: file.hookMissing > 0 ? `${file.hookMissing} missing hooks` :
                file.socketDataEvents > 0 ? `${file.outboundEvents}out/${file.inboundEvents}in` :
                file.sessionStarted ? 'session only' : 'no events'
        });
    }
    for (const file of socketFiles) {
        evidenceIndex.push({
            kind: 'sockets',
            source: file.source,
            phase: file.phase,
            count: file.connections.length,
            notes: `${file.ownedConnectionCount} owned, pid ${file.processId ?? 'n/a'}`
        });
    }
    for (const file of httpFiles) {
        const status = Object.entries(file.statusCounts)
            .map(([k, v]) => `${k}:${v}`)
            .join(',');
        const methodIds = [...file.methodIds.keys()].sort((a, b) => a - b);
        evidenceIndex.push({
            kind: 'http',
            source: file.source,
            phase: file.phase,
            count: file.records,
            notes: methodIds.length > 0
                ? `${status}; methodId ${methodIds.join(',')}`
                : (status || 'no records')
        });
    }

    const candidateEvidence = buildCandidateEvidence(fridaFiles, socketFiles, httpFiles);
    const evidenceGaps = buildEvidenceGaps(phases, fridaFiles, socketFiles, httpFiles);

    const blockers = [];
    const incomplete = phases.filter(p => p.status !== 'complete');
    if (incomplete.length > 0) {
        blockers.push(`Phases without enough proven rounds: ${incomplete.map(p => p.phase).join(', ')}.`);
    }
    const totalSocketData = fridaFiles.reduce((sum, f) => sum + f.socketDataEvents, 0);
    const totalNon443 = fridaFiles.reduce((sum, f) => sum + f.non443Connects, 0);
    if (totalSocketData === 0) {
        blockers.push('No socket-data events recorded; frame boundary, direction, and length evidence is absent.');
    }
    if (totalNon443 === 0) {
        blockers.push('No non-443 network connect recorded; no game gateway candidate is proven.');
    }
    if (!fridaFiles.some(f => f.inboundEvents > 0)) {
        blockers.push('No inbound socket-data direction recorded; request/response pairing is unproven.');
    }
    if (socketFiles.every(s => s.ownedConnectionCount === 0)) {
        blockers.push('No process-owned socket connection matched by inode; endpoint ownership is unproven.');
    }

    const result = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        config: path.relative(projectRoot, path.resolve(command.config)),
        directories: {
            sockets: path.relative(projectRoot, path.resolve(socketsDir)),
            frida: path.relative(projectRoot, path.resolve(fridaDir)),
            http: path.relative(projectRoot, path.resolve(httpDir))
        },
        counts: {
            socketSnapshots: socketFiles.length,
            fridaFiles: fridaFiles.length,
            httpFiles: httpFiles.length,
            fridaEvents: fridaFiles.reduce((sum, f) => sum + f.events, 0),
            socketDataEvents: totalSocketData,
            non443Connects: totalNon443
        },
        phases,
        evidenceIndex,
        candidateEvidence,
        evidenceGaps,
        blockers
    };

    const outputJson = `${JSON.stringify(result, null, 2)}\n`;
    if (command.output) {
        await import('node:fs/promises').then(fs => fs.mkdir(path.dirname(command.output), {
            recursive: true
        }));
        await import('node:fs/promises').then(fs => fs.writeFile(command.output, outputJson, 'utf8'));
    } else {
        process.stdout.write(outputJson);
    }

    if (command.markdown) {
        await import('node:fs/promises').then(fs => fs.mkdir(path.dirname(command.markdown), {
            recursive: true
        }));
        await import('node:fs/promises').then(fs => fs.writeFile(command.markdown, renderMarkdown(result), 'utf8'));
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
