'use strict';

const nativeBinding = require('./native');
const tcpTransport = require('./tcp-transport')(nativeBinding.UringTcpServer);

module.exports = {
  ...nativeBinding,
  IoUringTcpConnection: tcpTransport.IoUringTcpConnection,
  IoUringTcpTransportServer: tcpTransport.IoUringTcpTransportServer,
  createTcpServer: tcpTransport.createTcpServer
};
