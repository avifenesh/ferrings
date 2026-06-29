'use strict';

const { EventEmitter } = require('node:events');

function createTcpTransportExports(UringTcpServer) {
  class IoUringTcpConnection extends EventEmitter {
    constructor(server, event) {
      super();
      Object.defineProperties(this, {
        id: {
          value: event.connectionId,
          enumerable: true
        },
        remoteAddress: {
          value: event.remoteAddress || event.remoteAddr,
          enumerable: true
        },
        remoteFamily: {
          value: event.remoteFamily,
          enumerable: true
        },
        remotePort: {
          value: event.remotePort,
          enumerable: true
        },
        destroyed: {
          value: false,
          writable: true,
          enumerable: true
        },
        _server: {
          value: server
        }
      });
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
      if (options !== undefined && options !== null && !isPlainObject(options)) {
        throw new TypeError('options must be an object');
      }
      if (
        connectionListener !== undefined &&
        connectionListener !== null &&
        typeof connectionListener !== 'function'
      ) {
        throw new TypeError('connectionListener must be a function');
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
      const { options, callback } = parseStartArgs(this._baseOptions, args);
      return this._startWithOptions(options, callback);
    }

    listen(...args) {
      if (this._info) {
        throw new Error('server is already running');
      }
      const { options, callback } = parseListenArgs(this._baseOptions, args);
      this._startWithOptions(options, callback);
      return this;
    }

    _startWithOptions(options, callback) {
      if (this._info) {
        throw new Error('server is already running');
      }
      this._native = new UringTcpServer(options);
      let info;
      try {
        info = this._native.startBatch((events) => {
          this._handleNativeEvents(events);
        });
      } catch (error) {
        const native = this._native;
        this._native = null;
        this._info = null;
        this._closed = true;
        this._clearKeepAlive();
        if (native && typeof native.stop === 'function') {
          try {
            native.stop();
          } catch {}
        }
        throw error;
      }
      this._info = info;
      this._closed = false;
      this._ensureKeepAlive();
      try {
        if (callback) callback(info);
        this.emit('listening', info);
      } catch (error) {
        try {
          this.close();
        } catch (closeError) {
          attachCause(error, closeError);
        }
        throw error;
      }
      return info;
    }

    close(callback) {
      if (callback !== undefined && callback !== null && typeof callback !== 'function') {
        throw new TypeError('callback must be a function');
      }
      if (this._closed) {
        if (callback) callback();
        return this;
      }
      this._closed = true;
      const connections = [...this._connections.values()];
      this._connections.clear();
      const native = this._native;
      this._native = null;
      this._info = null;
      this._clearKeepAlive();

      let stopError;
      if (native) {
        try {
          native.stop();
        } catch (error) {
          stopError = error;
        }
      }

      let closeError = stopError;
      for (const connection of connections) {
        connection.destroyed = true;
        try {
          connection.emit('close');
        } catch (error) {
          if (!closeError) closeError = error;
        }
      }

      if (callback) {
        try {
          callback();
        } catch (error) {
          if (!closeError) closeError = error;
        }
      }
      try {
        this.emit('close');
      } catch (error) {
        if (!closeError) closeError = error;
      }
      if (closeError) {
        throw closeError;
      }
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
      const batch = normalizeBatchSends(sends, this);
      if (batch.hasDestroyedConnection) return false;
      return this._native ? this._native.sendBatch(batch.sends) : false;
    }

    sendBatchAndClose(sends) {
      const batch = normalizeBatchSends(sends, this);
      if (batch.hasDestroyedConnection) return false;
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
      if (this._closed) return;
      const errors = [];

      if (event.eventType === 'connect') {
        const existingConnection = this._connections.get(event.connectionId);
        if (existingConnection) {
          this._connections.delete(existingConnection.id);
          existingConnection.destroyed = true;
          emitCapturing(errors, existingConnection, 'close');
          emitCapturing(errors, this, 'connectionClose', existingConnection);
        }
        const connection = new IoUringTcpConnection(this, event);
        this._connections.set(connection.id, connection);
        emitCapturing(errors, this, 'connection', connection);
        throwCaptured(errors);
        return;
      }

      const connection = this._connectionFor(event, errors);
      if (!connection) return;

      if (event.eventType === 'data') {
        emitCapturing(errors, connection, 'data', event.data);
        emitCapturing(errors, this, 'data', connection, event.data);
      } else if (event.eventType === 'close') {
        this._connections.delete(connection.id);
        connection.destroyed = true;
        emitCapturing(errors, connection, 'close');
        emitCapturing(errors, this, 'connectionClose', connection);
      }
      throwCaptured(errors);
    }

    _handleNativeEvents(events) {
      let firstError;
      for (const event of events) {
        try {
          this._handleEvent(event);
        } catch (error) {
          if (!firstError) firstError = error;
        }
      }
      if (firstError) {
        throw firstError;
      }
    }

    _connectionFor(event, errors) {
      let connection = this._connections.get(event.connectionId);
      if (!connection && event.eventType === 'data') {
        connection = new IoUringTcpConnection(this, event);
        this._connections.set(connection.id, connection);
        emitCapturing(errors, this, 'connection', connection);
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

function parseStartArgs(baseOptions, args) {
  const options = { ...baseOptions };
  const values = [...args];
  let callback;

  if (values.length > 2) {
    throw new TypeError('start accepts at most options and callback arguments');
  }
  if (values.length > 1) {
    callback = values.pop();
    if (callback !== undefined && callback !== null && typeof callback !== 'function') {
      throw new TypeError('callback must be a function');
    }
  } else if (typeof values[0] === 'function') {
    callback = values.pop();
  }

  if (values.length === 0 || values[0] === undefined || values[0] === null) {
    return { options: normalizeListenOptions(options), callback };
  }
  if (!isPlainObject(values[0])) {
    throw new TypeError('start options must be an object');
  }
  Object.assign(options, values[0]);
  return { options: normalizeListenOptions(options), callback };
}

function parseListenArgs(baseOptions, args) {
  const options = { ...baseOptions };
  let callback;
  const values = [...args];
  if (typeof values[values.length - 1] === 'function') {
    callback = values.pop();
  }
  if (values.length > 3) {
    throw new TypeError('listen accepts at most port, host, and backlog arguments');
  }
  if (values.length > 0 && values[0] !== null && typeof values[0] === 'object') {
    if (!isPlainObject(values[0])) {
      throw new TypeError('listen options must be an object');
    }
    if (values.length > 1) {
      throw new TypeError('listen options object cannot be combined with positional arguments');
    }
    Object.assign(options, values[0]);
    return { options: normalizeListenOptions(options), callback };
  }

  if (values.length > 0 && values[0] !== undefined && values[0] !== null) {
    options.port = normalizePort(values[0]);
  }
  if (values.length > 1 && values[1] !== undefined && values[1] !== null) {
    if (typeof values[1] === 'string') {
      options.host = values[1];
    } else if (values.length === 2) {
      options.backlog = normalizeBacklog(values[1]);
    } else {
      throw new TypeError('host must be a string');
    }
  }
  if (values.length > 2 && values[2] !== undefined && values[2] !== null) {
    options.backlog = normalizeBacklog(values[2]);
  }

  return { options: normalizeListenOptions(options), callback };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function attachCause(error, cause) {
  if (!error || typeof error !== 'object' || error.cause !== undefined) return;
  try {
    error.cause = cause;
  } catch {}
}

function emitCapturing(errors, emitter, eventName, ...args) {
  try {
    emitter.emit(eventName, ...args);
  } catch (error) {
    errors.push(error);
  }
}

function throwCaptured(errors) {
  if (errors.length > 0) {
    throw errors[0];
  }
}

function normalizeListenOptions(options) {
  const normalized = { ...options };
  if (
    normalized.host !== undefined &&
    normalized.host !== null &&
    typeof normalized.host !== 'string'
  ) {
    throw new TypeError('host must be a string');
  }
  if (normalized.port !== undefined && normalized.port !== null) {
    normalized.port = normalizePort(normalized.port);
  }
  if (normalized.backlog !== undefined && normalized.backlog !== null) {
    normalized.backlog = normalizeBacklog(normalized.backlog);
  }
  return normalized;
}

function normalizePort(value) {
  const port = numberOption('port', value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('port must be an integer between 0 and 65535');
  }
  return port;
}

function normalizeBacklog(value) {
  const backlog = numberOption('backlog', value);
  if (!Number.isInteger(backlog) || backlog < 1 || backlog > 0x7fffffff) {
    throw new RangeError('backlog must be an integer between 1 and 2147483647');
  }
  return backlog;
}

function numberOption(name, value) {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  throw new TypeError(`${name} must be a number`);
}

function normalizeBatchSends(sends, server) {
  if (!Array.isArray(sends)) {
    throw new TypeError('sends must be an array');
  }

  const connections = [];
  let hasDestroyedConnection = false;
  const entries = sends.map((send) => {
    if (!isPlainObject(send)) {
      throw new TypeError('each send must be an object');
    }

    const connection = send.connection;
    if (connection !== undefined && connection !== null) {
      if (send.connectionId !== undefined && send.connectionId !== null) {
        throw new TypeError('send must include either connection or connectionId, not both');
      }
      if (typeof connection !== 'object' || connection._server !== server) {
        throw new TypeError('send connection must belong to this server');
      }
      if (connection.destroyed) {
        hasDestroyedConnection = true;
      }
    }
    const connectionId =
      send.connectionId !== undefined && send.connectionId !== null
        ? send.connectionId
        : connection && connection.id;
    if (!Number.isInteger(connectionId) || connectionId < 0 || connectionId > 0xffffffff) {
      throw new RangeError('send connectionId must be a uint32');
    }
    const trackedConnection = connection || server._connections.get(connectionId);
    if (trackedConnection && trackedConnection.destroyed) {
      hasDestroyedConnection = true;
    }
    if (trackedConnection) {
      connections.push(trackedConnection);
    }
    return {
      send,
      connectionId
    };
  });

  if (hasDestroyedConnection) {
    return {
      sends: [],
      connections,
      hasDestroyedConnection
    };
  }

  const normalized = entries.map(({ send, connectionId }) => {
    return {
      connectionId,
      data: toBuffer(send.data)
    };
  });

  return {
    sends: normalized,
    connections,
    hasDestroyedConnection
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
