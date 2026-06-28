'use strict';

const { EventEmitter } = require('node:events');

function createTcpTransportExports(UringTcpServer) {
  class IoUringTcpConnection extends EventEmitter {
    constructor(server, event) {
      super();
      this.id = event.connectionId;
      this.remoteAddress = event.remoteAddress || event.remoteAddr;
      this.remoteFamily = event.remoteFamily;
      this.remotePort = event.remotePort;
      this.destroyed = false;
      this._server = server;
    }

    write(data) {
      if (this.destroyed) return false;
      return this._server._send(this.id, toBuffer(data));
    }

    end(data) {
      if (this.destroyed) return false;
      if (data === undefined || data === null) {
        const accepted = this._server._closeConnection(this.id);
        if (accepted) this.destroyed = true;
        return accepted;
      }
      const accepted = this._server._sendAndClose(this.id, toBuffer(data));
      if (accepted) this.destroyed = true;
      return accepted;
    }

    destroy() {
      if (this.destroyed) return false;
      const accepted = this._server._closeConnection(this.id);
      if (accepted) this.destroyed = true;
      return accepted;
    }
  }

  class IoUringTcpTransportServer extends EventEmitter {
    constructor(options, connectionListener) {
      super();
      if (typeof options === 'function') {
        connectionListener = options;
        options = undefined;
      }
      this._baseOptions = options ? { ...options } : {};
      this._native = null;
      this._connections = new Map();
      this._info = null;
      this._keepAlive = null;
      this._keepAliveRefed = true;
      this._closed = true;
      if (connectionListener) {
        this.on('connection', connectionListener);
      }
    }

    start(...args) {
      if (this._info) {
        throw new Error('server is already running');
      }
      const { options, callback } = parseListenArgs(this._baseOptions, args);
      this._native = new UringTcpServer(options);
      const info = this._native.startBatch((events) => {
        for (const event of events) {
          this._handleEvent(event);
        }
      });
      this._info = info;
      this._closed = false;
      this._ensureKeepAlive();
      if (callback) callback(info);
      this.emit('listening', info);
      return info;
    }

    listen(...args) {
      this.start(...args);
      return this;
    }

    close(callback) {
      if (this._closed) {
        if (callback) callback();
        return this;
      }
      this._closed = true;
      for (const connection of this._connections.values()) {
        connection.destroyed = true;
        connection.emit('close');
      }
      this._connections.clear();
      if (this._native) {
        this._native.stop();
      }
      this._native = null;
      this._clearKeepAlive();
      this._info = null;
      if (callback) callback();
      this.emit('close');
      return this;
    }

    stop() {
      this.close();
    }

    info() {
      return this._native ? this._native.info() : null;
    }

    address() {
      const info = this.info() || this._info;
      if (!info) return null;
      return {
        address: info.host,
        family: info.host.includes(':') ? 'IPv6' : 'IPv4',
        port: info.port
      };
    }

    connections() {
      return [...this._connections.values()];
    }

    getConnections(callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('callback must be a function');
      }
      process.nextTick(() => {
        callback(null, this._connectionCount());
      });
      return this;
    }

    sendBatch(sends) {
      const batch = normalizeBatchSends(sends);
      return this._native ? this._native.sendBatch(batch.sends) : false;
    }

    sendBatchAndClose(sends) {
      const batch = normalizeBatchSends(sends);
      if (!this._native) return false;
      const accepted = this._native.sendBatchAndClose(batch.sends);
      if (accepted) {
        for (const connection of batch.connections) {
          connection.destroyed = true;
        }
      }
      return accepted;
    }

    ref() {
      this._keepAliveRefed = true;
      if (this._keepAlive && typeof this._keepAlive.ref === 'function') {
        this._keepAlive.ref();
      }
      return this;
    }

    unref() {
      this._keepAliveRefed = false;
      if (this._keepAlive && typeof this._keepAlive.unref === 'function') {
        this._keepAlive.unref();
      }
      return this;
    }

    _handleEvent(event) {
      if (event.eventType === 'connect') {
        const connection = new IoUringTcpConnection(this, event);
        this._connections.set(connection.id, connection);
        this.emit('connection', connection);
        return;
      }

      const connection = this._connectionFor(event);
      if (!connection) return;

      if (event.eventType === 'data') {
        connection.emit('data', event.data);
        this.emit('data', connection, event.data);
      } else if (event.eventType === 'close') {
        this._connections.delete(connection.id);
        connection.destroyed = true;
        connection.emit('close');
        this.emit('connectionClose', connection);
      }
    }

    _connectionFor(event) {
      let connection = this._connections.get(event.connectionId);
      if (!connection && event.eventType === 'data') {
        connection = new IoUringTcpConnection(this, event);
        this._connections.set(connection.id, connection);
        this.emit('connection', connection);
      }
      return connection;
    }

    _send(connectionId, data) {
      return this._native ? this._native.send(connectionId, data) : false;
    }

    _sendAndClose(connectionId, data) {
      return this._native ? this._native.sendAndClose(connectionId, data) : false;
    }

    _closeConnection(connectionId) {
      return this._native ? this._native.closeConnection(connectionId) : false;
    }

    _connectionCount() {
      const info = this.info();
      return info ? info.activeConnections : this._connections.size;
    }

    _ensureKeepAlive() {
      if (this._keepAlive) return;
      this._keepAlive = setInterval(() => {}, 1 << 30);
      if (!this._keepAliveRefed && typeof this._keepAlive.unref === 'function') {
        this._keepAlive.unref();
      }
    }

    _clearKeepAlive() {
      if (!this._keepAlive) return;
      clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
  }

  return {
    IoUringTcpConnection,
    IoUringTcpTransportServer,
    createTcpServer(options, connectionListener) {
      return new IoUringTcpTransportServer(options, connectionListener);
    }
  };
}

function parseListenArgs(baseOptions, args) {
  const options = { ...baseOptions };
  let callback;
  const values = [...args];
  if (typeof values[values.length - 1] === 'function') {
    callback = values.pop();
  }

  if (values.length === 1 && isPlainObject(values[0])) {
    Object.assign(options, values[0]);
    return { options, callback };
  }

  if (values.length > 0 && values[0] !== undefined && values[0] !== null) {
    options.port = normalizePort(values[0]);
  }
  if (values.length > 1 && values[1] !== undefined && values[1] !== null) {
    if (typeof values[1] === 'string' && !isNumericString(values[1])) {
      options.host = values[1];
    } else if (values.length === 2) {
      options.backlog = normalizeBacklog(values[1]);
    }
  }
  if (values.length > 2 && values[2] !== undefined && values[2] !== null) {
    options.backlog = normalizeBacklog(values[2]);
  }

  return { options, callback };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePort(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return value;
}

function normalizeBacklog(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return value;
}

function isNumericString(value) {
  return value.trim() !== '' && Number.isFinite(Number(value));
}

function normalizeBatchSends(sends) {
  if (!Array.isArray(sends)) {
    throw new TypeError('sends must be an array');
  }

  const connections = [];
  const normalized = sends.map((send) => {
    if (!isPlainObject(send)) {
      throw new TypeError('each send must be an object');
    }

    const connection = send.connection;
    const connectionId =
      send.connectionId !== undefined && send.connectionId !== null
        ? send.connectionId
        : connection && connection.id;
    if (!Number.isInteger(connectionId) || connectionId < 0 || connectionId > 0xffffffff) {
      throw new RangeError('send connectionId must be a uint32');
    }
    if (connection && typeof connection === 'object') {
      connections.push(connection);
    }
    return {
      connectionId,
      data: toBuffer(send.data)
    };
  });

  return {
    sends: normalized,
    connections
  };
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('data must be a Buffer, string, or Uint8Array');
}

module.exports = createTcpTransportExports;
