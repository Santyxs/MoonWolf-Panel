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
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map();

function getRoom(token) {
  let room = rooms.get(token);

  if (!room) {
    room = { agent: null, panels: new Set() };
    rooms.set(token, room);
  }

  return room;
}

function broadcastToPanels(room, event, payload) {
  for (const panel of room.panels) {
    if (panel.connected) {
      panel.emit(event, payload);
    }
  }
}

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const role = auth.role;
  const token = String(auth.token || '');

  if (!token) {
    return next(new Error('Token requerido.'));
  }

  if (role !== 'panel' && role !== 'agent') {
    return next(new Error('Rol no válido.'));
  }

  socket.data.role = role;
  socket.data.token = token;
  next();
});

io.on('connection', socket => {
  const { role, token } = socket.data;
  const room = getRoom(token);

  socket.join(`mw:${token}`);

  if (role === 'agent') {
    if (room.agent && room.agent !== socket) {
      room.agent.disconnect(true);
    }

    room.agent = socket;
    socket.emit('cloud_ready', { agentOnline: true });
    broadcastToPanels(room, 'agent_status', { online: true });
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

  socket.on('rpc_result', packet => {
    if (role !== 'agent') return;

    const result = packet && typeof packet === 'object' && packet.result && typeof packet.result === 'object'
      ? packet.result
      : packet;

    if (!result || typeof result.id !== 'string') {
      return;
    }

    broadcastToPanels(room, 'rpc_result', result);
  });

  socket.on('event', event => {
    if (role !== 'agent') return;
    if (!event || typeof event.name !== 'string') return;
    broadcastToPanels(room, event.name, event.payload);
  });

  socket.on('agent_event', event => {
    if (role !== 'agent') return;
    if (!event || typeof event.name !== 'string') return;
    broadcastToPanels(room, event.name, event.payload);
  });

  socket.on('disconnect', () => {
    if (role === 'agent' && room.agent === socket) {
      room.agent = null;
      broadcastToPanels(room, 'agent_status', { online: false });
    }

    if (role === 'panel') {
      room.panels.delete(socket);
    }

    if (!room.agent && room.panels.size === 0) {
      rooms.delete(token);
    }
  });
});

module.exports = server;
