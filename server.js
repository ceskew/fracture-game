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

function broadcastRoom(roomCode, event, payload, excludeClientId = null) {
  for (const [id, c] of clients.entries()) {
    if (c.roomCode === roomCode && id !== excludeClientId) {
      sendSSE(c.res, event, payload);
    }
  }
}

function getOpenRoomsSummary() {
  const list = [];
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    // Expire stale waiting rooms after 2 hours
    if (now - room.createdAt > 7200000) {
      rooms.delete(code);
      continue;
    }
    if (room.status === 'waiting') {
      list.push({
        code,
        hostName: room.players[1]?.name || 'Host',
        poolHP: room.poolHP
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

    clients.set(clientId, { res, roomCode, name: url.searchParams.get('name') || 'Commander' });
    sendSSE(res, 'hello', {
      clientId,
      playersOnline: clients.size,
      rooms: getOpenRoomsSummary(),
      leaderboard,
      globalChat
    });

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const entry = clients.get(clientId);
      clients.delete(clientId);
      if (entry && entry.roomCode && rooms.has(entry.roomCode)) {
        const room = rooms.get(entry.roomCode);
        if (room.players[1]?.clientId === clientId || room.players[2]?.clientId === clientId) {
          broadcastRoom(entry.roomCode, 'opponent_left', { name: entry.name }, clientId);
        }
      }
    });
    return;
  }

  try {
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
      return json(res, 200, { rooms: getOpenRoomsSummary() });
    }
    if (req.method === 'POST' && pathname === '/api/rooms') {
      const { hostName, poolHP, mapId, clientId } = await readBody(req);
      const code = generateRoomCode();
      const cleanHost = String(hostName || 'Commander').trim().slice(0, 20);
      const cleanPool = Math.max(40, Math.min(240, Number(poolHP) || 100));
      const cleanMap = String(mapId || 'timberline').slice(0, 24);
      const room = {
        code,
        poolHP: cleanPool,
        mapId: cleanMap,
        status: 'waiting', // waiting -> drafting -> battle
        players: { 1: { name: cleanHost, clientId }, 2: null },
        squads: { 1: null, 2: null },
        chat: [],
        createdAt: Date.now()
      };
      rooms.set(code, room);
      if (clientId && clients.has(clientId)) {
        clients.get(clientId).roomCode = code;
        clients.get(clientId).name = cleanHost;
      }
      broadcastAll('rooms_update', { rooms: getOpenRoomsSummary() });
      return json(res, 200, { code, playerNum: 1, poolHP: cleanPool, mapId: cleanMap, hostName: cleanHost });
    }

    const roomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4})\/(join|squad|action|rematch)$/);
    if (req.method === 'POST' && roomMatch) {
      const code = roomMatch[1].toUpperCase();
      const actionType = roomMatch[2];
      const room = rooms.get(code);
      if (!room) return json(res, 404, { error: 'Room not found' });
      const body = await readBody(req);

      if (actionType === 'join') {
        if (room.status !== 'waiting' || room.players[2]) {
          return json(res, 409, { error: 'Room is already full' });
        }
        const cleanGuest = String(body.playerName || 'Challenger').trim().slice(0, 20);
        room.players[2] = { name: cleanGuest, clientId: body.clientId };
        room.status = 'drafting';
        if (body.clientId && clients.has(body.clientId)) {
          clients.get(body.clientId).roomCode = code;
          clients.get(body.clientId).name = cleanGuest;
        }
        broadcastAll('rooms_update', { rooms: getOpenRoomsSummary() });
        broadcastRoom(code, 'room_joined', {
          code,
          poolHP: room.poolHP,
          mapId: room.mapId,
          p1Name: room.players[1].name,
          p2Name: cleanGuest
        });
        return json(res, 200, {
          code,
          playerNum: 2,
          poolHP: room.poolHP,
          mapId: room.mapId,
          p1Name: room.players[1].name,
          p2Name: cleanGuest
        });
      }

      if (actionType === 'squad') {
        const pNum = Number(body.playerNum);
        if ((pNum !== 1 && pNum !== 2) || !Array.isArray(body.squad)) {
          return json(res, 400, { error: 'Invalid squad submission' });
        }
        const total = body.squad.reduce((s, u) => s + Number(u.maxHP || 0), 0);
        if (total !== room.poolHP) {
          return json(res, 400, { error: `Squad HP (${total}) must equal agreed pool (${room.poolHP})` });
        }
        room.squads[pNum] = body.squad;
        broadcastRoom(code, 'squad_ready', { playerNum: pNum });

        if (room.squads[1] && room.squads[2]) {
          room.status = 'battle';
          const seed = Math.floor(Math.random() * 1e9);
          broadcastRoom(code, 'battle_start', {
            code,
            poolHP: room.poolHP,
            mapId: room.mapId,
            p1Name: room.players[1].name,
            p2Name: room.players[2].name,
            squads: room.squads,
            seed
          });
        }
        return json(res, 200, { ok: true, bothReady: Boolean(room.squads[1] && room.squads[2]) });
      }

      if (actionType === 'action') {
        broadcastRoom(code, 'action', body, body.clientId || null);
        return json(res, 200, { ok: true });
      }

      if (actionType === 'rematch') {
        room.squads = { 1: null, 2: null };
        room.status = 'drafting';
        broadcastRoom(code, 'rematch_start', { code, poolHP: room.poolHP, mapId: room.mapId });
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
