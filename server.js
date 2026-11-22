#!/usr/bin/env node
'use strict';

/**
 * FRACTURE — Zero-Dependency Real-Time Multiplayer, ELO Leaderboard & Chat Server
 * Run: node server.js   (or double-click "Start FRACTURE Server.command")
 * Deploy anywhere Node 18+ runs (Render, Railway, Fly.io, VPS) with PORT env var.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const DIR = __dirname;
const HTML_PATH = path.join(DIR, 'FRACTURE.html');
const LB_PATH = path.join(DIR, 'leaderboard.json');

/* ============================================================================
   1. PERSISTENT ELO LEADERBOARD
   ============================================================================ */
const DEFAULT_LEADERBOARD = [
  { name: 'AI: The Monolith', elo: 1240, wins: 4, losses: 2, style: 'Titan' },
  { name: 'AI: Combined Arms', elo: 1215, wins: 3, losses: 2, style: 'Triad' },
  { name: 'AI: The Hive', elo: 1185, wins: 2, losses: 3, style: 'Swarm' }
];

function loadLeaderboard() {
  try {
    if (fs.existsSync(LB_PATH)) {
      const data = JSON.parse(fs.readFileSync(LB_PATH, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    console.error('Failed to read leaderboard.json:', err.message);
  }
  return DEFAULT_LEADERBOARD.map(r => ({ ...r }));
}

function saveLeaderboard(board) {
  try {
    fs.writeFileSync(LB_PATH, JSON.stringify(board, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write leaderboard.json:', err.message);
  }
}

let leaderboard = loadLeaderboard();

function recordMatchResult(winnerName, loserName, winnerStyle, loserStyle) {
  const findOrCreate = (name, style) => {
    let row = leaderboard.find(r => r.name.toLowerCase() === name.toLowerCase());
    if (!row) {
      row = { name, elo: 1200, wins: 0, losses: 0, style: style || 'Custom' };
      leaderboard.push(row);
    }
    if (style) row.style = style;
    return row;
  };
  const w = findOrCreate(winnerName, winnerStyle);
  const l = findOrCreate(loserName, loserStyle);
  const K = 32;
  const expW = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));
  const delta = Math.round(K * (1 - expW));
  w.elo += delta;
  w.wins += 1;
  l.elo = Math.max(800, l.elo - delta);
  l.losses += 1;
  leaderboard.sort((a, b) => b.elo - a.elo);
  saveLeaderboard(leaderboard);
  broadcastAll('leaderboard_update', { board: leaderboard });
  return { delta, board: leaderboard };
}

/* ============================================================================
   2. ROOMS, CHAT & SSE CLIENT REGISTRY
   ============================================================================ */
const rooms = new Map(); // code -> { code, poolHP, status, players: {1, 2}, squads: {1, 2}, chat: [], createdAt }
const globalChat = [];   // last 40 lobby chat messages
const clients = new Map(); // clientId -> { res, roomCode, name }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function sendSSE(res, event, payload) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch (_) {}
}

function broadcastAll(event, payload) {
  for (const c of clients.values()) {
    sendSSE(c.res, event, payload);
  }
}

function sanitizeSnapshotForSpectator(snap) {
  if (!snap) return null;
  const safeTraps = {};
  if (snap.traps) {
    for (const [owner, list] of Object.entries(snap.traps)) {
      safeTraps[owner] = Array.isArray(list) ? list.map(() => ({ id: 'secret', name: 'Secret Trap' })) : [];
    }
  }
  return {
    ...snap,
    hands: {},
    decks: {},
    traps: safeTraps
  };
}

function broadcastRoom(roomCode, event, payload, excludeClientId = null) {
  const room = rooms.get(roomCode);
  for (const [id, c] of clients.entries()) {
    if (c.roomCode === roomCode && id !== excludeClientId) {
      const isSpec = Boolean(room && room.spectators && room.spectators.has(id));
      if (isSpec && event === 'action' && payload && payload.snapshot) {
        sendSSE(c.res, event, { ...payload, snapshot: sanitizeSnapshotForSpectator(payload.snapshot) });
      } else {
        sendSSE(c.res, event, payload);
      }
    }
  }
}

function getRoomPlayerNames(room) {
  const names = {};
  for (let i = 1; i <= (room.maxPlayers || 2); i++) {
    if (room.players[i]) names[i] = room.players[i].name;
  }
  return names;
}

function getOnlinePlayersSummary() {
  const list = [];
  for (const [id, c] of clients.entries()) {
    const room = c.roomCode ? rooms.get(c.roomCode) : null;
    const joined = room ? Object.values(room.players).filter(Boolean).length : 0;
    const maxP = room ? (room.maxPlayers || 2) : 2;
    const isSpec = Boolean(room && room.spectators && room.spectators.has(id));
    const status = room
      ? (isSpec ? `Watching ${c.roomCode}` : (room.status === 'waiting' ? `Hosting ${c.roomCode} (${joined}/${maxP})` : `In Match ${c.roomCode}`))
      : 'In Lobby';
    list.push({
      id,
      name: c.name || 'Commander',
      status,
      roomCode: c.roomCode || null,
      joinable: Boolean(room && room.status === 'waiting' && !isSpec),
      watchable: Boolean(room && (room.status === 'battle' || room.status === 'drafting'))
    });
  }
  return list;
}

function broadcastPresence() {
  broadcastAll('presence_update', {
    playersOnline: clients.size,
    onlinePlayers: getOnlinePlayersSummary()
  });
}

function getOpenRoomsSummary() {
  const list = [];
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    // Expire stale rooms after 2 hours
    if (now - room.createdAt > 7200000) {
      rooms.delete(code);
      continue;
    }
    if (room.status === 'waiting') {
      const joinedCount = Object.values(room.players).filter(Boolean).length;
      list.push({
        code,
        hostName: room.players[1]?.name || 'Host',
        poolHP: room.poolHP,
        maxPlayers: room.maxPlayers || 2,
        joinedCount
      });
    }
  }
  return list;
}

function getLiveMatchesSummary() {
  const list = [];
  for (const [code, room] of rooms.entries()) {
    if (room.status === 'battle' || room.status === 'drafting') {
      list.push({
        code,
        status: room.status,
        poolHP: room.poolHP,
        mapId: room.mapId,
        maxPlayers: room.maxPlayers || 2,
        playerNames: getRoomPlayerNames(room),
        turn: room.state?.turn || 1,
        spectators: room.spectators ? room.spectators.size : 0
      });
    }
  }
  return list;
}

/* ============================================================================
   3. HTTP REQUEST HELPERS
   ============================================================================ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

/* ============================================================================
   4. HTTP SERVER & API ROUTES
   ============================================================================ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Handle favicon requests cleanly without 404
  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve FRACTURE.html
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/FRACTURE.html')) {
    try {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Could not read FRACTURE.html: ' + err.message);
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, playersOnline: clients.size, activeRooms: rooms.size });
  }

  // SSE Real-Time Event Stream
  if (req.method === 'GET' && pathname === '/api/stream') {
    const clientId = url.searchParams.get('clientId') || crypto.randomBytes(8).toString('hex');
    const roomCode = (url.searchParams.get('room') || '').toUpperCase() || null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');

    const cleanName = String(url.searchParams.get('name') || 'Commander').trim().slice(0, 18) || 'Commander';
    const prevClient = clients.get(clientId);
    if (prevClient && prevClient.roomCode && prevClient.roomCode !== roomCode && rooms.has(prevClient.roomCode)) {
      const oldRoom = rooms.get(prevClient.roomCode);
      if (oldRoom.spectators && oldRoom.spectators.delete(clientId)) {
        broadcastRoom(prevClient.roomCode, 'spectator_update', { count: oldRoom.spectators.size });
      }
    }
    clients.set(clientId, { res, roomCode, name: cleanName });
    sendSSE(res, 'hello', {
      clientId,
      playersOnline: clients.size,
      onlinePlayers: getOnlinePlayersSummary(),
      rooms: getOpenRoomsSummary(),
      liveMatches: getLiveMatchesSummary(),
      leaderboard,
      globalChat
    });
    broadcastPresence();

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const entry = clients.get(clientId);
      if (entry && entry.res !== res) return;
      clients.delete(clientId);
      if (entry && entry.roomCode && rooms.has(entry.roomCode)) {
        const room = rooms.get(entry.roomCode);
        if (room.spectators && room.spectators.delete(clientId)) {
          broadcastRoom(entry.roomCode, 'spectator_update', { count: room.spectators.size });
          broadcastAll('rooms_update', { rooms: getOpenRoomsSummary(), liveMatches: getLiveMatchesSummary() });
        } else if (Object.values(room.players).some(p => p && p.clientId === clientId)) {
          broadcastRoom(entry.roomCode, 'opponent_left', { name: entry.name }, clientId);
        }
      }
      broadcastPresence();
    });
    return;
  }

  try {
    // Live Presence Name Update API
    if (req.method === 'POST' && pathname === '/api/presence') {
      const { clientId, name } = await readBody(req);
      if (clientId && clients.has(clientId)) {
        clients.get(clientId).name = String(name || 'Commander').trim().slice(0, 18) || 'Commander';
        broadcastPresence();
      }
      return json(res, 200, { ok: true, onlinePlayers: getOnlinePlayersSummary() });
    }

    // Leaderboard API
    if (req.method === 'GET' && pathname === '/api/leaderboard') {
      return json(res, 200, { board: leaderboard });
    }
    if (req.method === 'POST' && pathname === '/api/leaderboard/match') {
      const { winnerName, loserName, winnerStyle, loserStyle } = await readBody(req);
      if (!winnerName || !loserName) return json(res, 400, { error: 'Missing player names' });
      const result = recordMatchResult(
        String(winnerName).slice(0, 24),
        String(loserName).slice(0, 24),
        String(winnerStyle || 'Custom').slice(0, 16),
        String(loserStyle || 'Custom').slice(0, 16)
      );
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/leaderboard/reset') {
      leaderboard = DEFAULT_LEADERBOARD.map(r => ({ ...r }));
      saveLeaderboard(leaderboard);
      broadcastAll('leaderboard_update', { board: leaderboard });
      return json(res, 200, { board: leaderboard });
    }

    // Chat API (Global or Room-scoped)
    if (req.method === 'POST' && pathname === '/api/chat') {
      const { sender, text, roomCode } = await readBody(req);
      const cleanSender = String(sender || 'Commander').trim().slice(0, 36);
      const cleanText = String(text || '').trim().slice(0, 160);
      if (!cleanText) return json(res, 400, { error: 'Empty message' });

      const msg = { sender: cleanSender, text: cleanText, ts: Date.now(), roomCode: roomCode || null };
      if (roomCode && rooms.has(roomCode.toUpperCase())) {
        const code = roomCode.toUpperCase();
        const room = rooms.get(code);
        room.chat.push(msg);
        if (room.chat.length > 60) room.chat.shift();
        broadcastRoom(code, 'chat', msg);
      } else {
        globalChat.push(msg);
        if (globalChat.length > 40) globalChat.shift();
        broadcastAll('chat', msg);
      }
      return json(res, 200, { ok: true, msg });
    }

    // Rooms API
    if (req.method === 'GET' && pathname === '/api/rooms') {
      return json(res, 200, { rooms: getOpenRoomsSummary(), liveMatches: getLiveMatchesSummary() });
    }
    if (req.method === 'POST' && pathname === '/api/rooms') {
      const { hostName, poolHP, mapId, maxPlayers, clientId } = await readBody(req);
      const code = generateRoomCode();
      const cleanHost = String(hostName || 'Commander').trim().slice(0, 20);
      const cleanPool = Math.max(40, Math.min(240, Number(poolHP) || 100));
      const cleanMax = Math.max(2, Math.min(4, Number(maxPlayers) || 2));
      const cleanMap = cleanMax > 2 ? 'crossfire' : String(mapId || 'timberline').slice(0, 24);
      const room = {
        code,
        poolHP: cleanPool,
        mapId: cleanMap,
        maxPlayers: cleanMax,
        status: 'waiting', // waiting -> drafting -> battle -> finished
        players: { 1: { name: cleanHost, clientId } },
        squads: {},
        spectators: new Set(),
        seed: null,
        chat: [],
        createdAt: Date.now()
      };
      rooms.set(code, room);
      if (clientId && clients.has(clientId)) {
        clients.get(clientId).roomCode = code;
        clients.get(clientId).name = cleanHost;
      }
      broadcastAll('rooms_update', { rooms: getOpenRoomsSummary(), liveMatches: getLiveMatchesSummary() });
      broadcastPresence();
      return json(res, 200, { code, playerNum: 1, poolHP: cleanPool, mapId: cleanMap, maxPlayers: cleanMax, hostName: cleanHost });
    }

    const roomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4})\/(join|squad|action|rematch|spectate)$/);
    if (req.method === 'POST' && roomMatch) {
      const code = roomMatch[1].toUpperCase();
      const actionType = roomMatch[2];
      const room = rooms.get(code);
      if (!room) return json(res, 404, { error: 'Room not found' });
      const body = await readBody(req);

      if (actionType === 'join') {
        const maxP = room.maxPlayers || 2;
        let seatNum = null;
        for (let i = 1; i <= maxP; i++) {
          if (!room.players[i]) { seatNum = i; break; }
        }
        if (room.status !== 'waiting' || !seatNum) {
          return json(res, 409, { error: 'Room is already full' });
        }
        const cleanGuest = String(body.playerName || 'Challenger').trim().slice(0, 20);
        room.players[seatNum] = { name: cleanGuest, clientId: body.clientId };
        const joinedCount = Object.values(room.players).filter(Boolean).length;
        const allJoined = joinedCount >= maxP;
        if (allJoined) room.status = 'drafting';
        if (body.clientId && clients.has(body.clientId)) {
          clients.get(body.clientId).roomCode = code;
          clients.get(body.clientId).name = cleanGuest;
        }
        const playerNames = getRoomPlayerNames(room);
        broadcastAll('rooms_update', { rooms: getOpenRoomsSummary(), liveMatches: getLiveMatchesSummary() });
        broadcastPresence();
        if (allJoined) {
          broadcastRoom(code, 'room_joined', {
            code,
            poolHP: room.poolHP,
            mapId: room.mapId,
            maxPlayers: maxP,
            playerNames,
            p1Name: playerNames[1] || 'Player 1',
            p2Name: playerNames[2] || 'Player 2'
          });
        } else {
          broadcastRoom(code, 'room_waiting', {
            code,
            joinedCount,
            maxPlayers: maxP,
            playerNames
          });
        }
        return json(res, 200, {
          code,
          playerNum: seatNum,
          poolHP: room.poolHP,
          mapId: room.mapId,
          maxPlayers: maxP,
          joinedCount,
          allJoined,
          playerNames,
          p1Name: playerNames[1] || 'Player 1',
          p2Name: playerNames[2] || 'Player 2'
        });
      }

      if (actionType === 'spectate') {
        const viewerName = String(body.viewerName || 'Spectator').trim().slice(0, 18) || 'Spectator';
        if (!room.spectators) room.spectators = new Set();
        if (body.clientId) {
          room.spectators.add(body.clientId);
          if (clients.has(body.clientId)) {
            clients.get(body.clientId).roomCode = code;
            clients.get(body.clientId).name = viewerName;
          }
        }
        broadcastRoom(code, 'spectator_update', { count: room.spectators.size });
        broadcastAll('rooms_update', { rooms: getOpenRoomsSummary(), liveMatches: getLiveMatchesSummary() });
        broadcastPresence();
        const playerNames = getRoomPlayerNames(room);
        return json(res, 200, {
          code,
          status: room.status,
          poolHP: room.poolHP,
          mapId: room.mapId,
          maxPlayers: room.maxPlayers || 2,
          playerNames,
          p1Name: playerNames[1] || 'Player 1',
          p2Name: playerNames[2] || 'Player 2',
          squads: (room.status === 'battle' || room.status === 'finished') ? room.squads : null,
          seed: room.seed || null,
          snapshot: room.state ? sanitizeSnapshotForSpectator(room.state) : null,
          seq: room.seq || 0,
          spectators: room.spectators.size,
          chat: room.chat || []
        });
      }

      if (actionType === 'squad') {
        const maxP = room.maxPlayers || 2;
        const pNum = Number(body.playerNum);
        if (pNum < 1 || pNum > maxP || !Array.isArray(body.squad)) {
          return json(res, 400, { error: 'Invalid squad submission' });
        }
        const total = body.squad.reduce((s, u) => s + Number(u.maxHP || 0), 0);
        if (total !== room.poolHP) {
          return json(res, 400, { error: `Squad HP (${total}) must equal agreed pool (${room.poolHP})` });
        }
        room.squads[pNum] = body.squad;
        const readyCount = Object.values(room.squads).filter(Boolean).length;
        const allReady = readyCount >= maxP;
        broadcastRoom(code, 'squad_ready', { playerNum: pNum, readyCount, maxPlayers: maxP });

        if (allReady) {
          room.status = 'battle';
          const seed = Math.floor(Math.random() * 1e9);
          room.seed = seed;
          room.seq = 0;
          room.activePlayer = (seed % maxP) + 1;
          room.state = null;
          room.winnerRecorded = false;
          const playerNames = getRoomPlayerNames(room);
          broadcastRoom(code, 'battle_start', {
            code,
            poolHP: room.poolHP,
            mapId: room.mapId,
            maxPlayers: maxP,
            playerNames,
            p1Name: playerNames[1] || 'Player 1',
            p2Name: playerNames[2] || 'Player 2',
            squads: room.squads,
            seed,
            spectators: room.spectators ? room.spectators.size : 0
          });
          broadcastAll('rooms_update', { rooms: getOpenRoomsSummary(), liveMatches: getLiveMatchesSummary() });
          broadcastPresence();
        }
        return json(res, 200, { ok: true, bothReady: allReady, readyCount, maxPlayers: maxP });
      }

      if (actionType === 'action') {
        const maxP = room.maxPlayers || 2;
        let senderSeat = null;
        for (let i = 1; i <= maxP; i++) {
          if (room.players[i] && room.players[i].clientId === body.clientId) {
            senderSeat = i;
            break;
          }
        }
        if (!senderSeat) {
          return json(res, 403, { error: 'Spectators cannot submit match actions' });
        }
        if (room.winnerRecorded) {
          return json(res, 409, { error: 'Match already concluded', seq: room.seq });
        }
        if (room.activePlayer && senderSeat !== room.activePlayer) {
          return json(res, 409, { error: 'Not your turn', activePlayer: room.activePlayer, seq: room.seq });
        }
        room.seq = (room.seq || 0) + 1;
        let officialResult = null;
        if (body.snapshot) {
          room.state = body.snapshot;
          if (body.snapshot.activePlayer) room.activePlayer = body.snapshot.activePlayer;
          if (body.snapshot.gameOver && !room.winnerRecorded) {
            room.winnerRecorded = true;
            room.status = 'finished';
            const aliveOwners = [...new Set((body.snapshot.units || []).filter(u => u.alive && u.hp > 0).map(u => u.owner))];
            const winner = aliveOwners[0] || senderSeat || 1;
            let delta = 0;
            if (maxP === 2) {
              const loser = winner === 1 ? 2 : 1;
              const styleOf = sq => (!sq || sq.length === 1) ? 'Titan' : sq.length === 2 ? 'Twins' : sq.length === 3 ? 'Triad' : sq.length >= 5 ? 'Swarm' : 'Squad';
              const resElo = recordMatchResult(
                room.players[winner]?.name || `Player ${winner}`,
                room.players[loser]?.name || `Player ${loser}`,
                styleOf(room.squads[winner]),
                styleOf(room.squads[loser])
              );
              delta = resElo.delta;
            }
            officialResult = { winner, delta };
            broadcastAll('rooms_update', { rooms: getOpenRoomsSummary(), liveMatches: getLiveMatchesSummary() });
          }
        }
        const payload = { ...body, seq: room.seq, officialResult };
        broadcastRoom(code, 'action', payload, body.clientId || null);
        return json(res, 200, { ok: true, seq: room.seq, officialResult });
      }

      if (actionType === 'rematch') {
        room.squads = {};
        room.status = 'drafting';
        room.seq = 0;
        room.seed = null;
        room.state = null;
        room.winnerRecorded = false;
        room.activePlayer = null;
        broadcastRoom(code, 'rematch_start', { code, poolHP: room.poolHP, mapId: room.mapId, maxPlayers: room.maxPlayers || 2 });
        broadcastAll('rooms_update', { rooms: getOpenRoomsSummary(), liveMatches: getLiveMatchesSummary() });
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n  FRACTURE Online Server running!`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}  (share on Wi-Fi)\n`);
});
