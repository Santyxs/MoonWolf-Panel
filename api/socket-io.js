'use strict';

const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, service: 'MoonWolf Cloud', websocket: true }));
});

const io = new Server(server, {
  path: '/api/socket-io/socket.io',
  transports: ['websocket'],
  maxHttpBufferSize: 60 * 1024 * 1024,
  cors: {
    origin: 'https://moon-wolf-panel.vercel.app',
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map();
const CODE_RE = /^MW-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { agent: null, panels: new Set() };
    rooms.set(code, room);
  }
  return room;
}

function broadcast(room, event, payload) {
  for (const panel of room.panels) {
    if (panel.connected) panel.emit(event, payload);
  }
}

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const role = auth.role;
  const code = String(auth.token || '');

  if (!CODE_RE.test(code)) return next(new Error('Código de conexión inválido.'));
  if (role !== 'panel' && role !== 'agent') return next(new Error('Rol no válido.'));

  socket.data.role = role;
  socket.data.code = code;
  next();
});

io.on('connection', socket => {
  const { role, code } = socket.data;
  const room = getRoom(code);

  socket.join(`mw:${code}`);

  if (role === 'agent') {
    if (room.agent && room.agent !== socket) {
      room.agent.disconnect(true);
    }
    room.agent = socket;
    socket.emit('cloud_ready', { agentOnline: true });
    broadcast(room, 'agent_status', { online: true });
  } else {
    room.panels.add(socket);
    socket.emit('cloud_ready', {
      agentOnline: Boolean(room.agent && room.agent.connected),
    });
  }

  socket.on('rpc', request => {
    if (role !== 'panel') return;

    if (!room.agent || !room.agent.connected) {
      return socket.emit('rpc_result', {
        id: request?.id,
        ok: false,
        status: 503,
        data: { ok: false, error: 'MoonWolf Agent no está conectado.' },
      });
    }

    room.agent.emit('rpc', request);
  });

  socket.on('rpc_result', result => {
    if (role !== 'agent') return;
    broadcast(room, 'rpc_result', result);
  });

  socket.on('agent_event', event => {
    if (role !== 'agent') return;
    const name = typeof event?.name === 'string' ? event.name : '';
    if (!['status', 'log', 'history', 'stats'].includes(name)) return;
    broadcast(room, name, event.payload);
  });

  socket.on('disconnect', () => {
    if (role === 'agent' && room.agent === socket) {
      room.agent = null;
      broadcast(room, 'agent_status', { online: false });
    }

    if (role === 'panel') room.panels.delete(socket);

    if (!room.agent && room.panels.size === 0) {
      rooms.delete(code);
    }
  });
});

module.exports = server;
