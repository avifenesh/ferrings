mod uring;

use napi::bindgen_prelude::{Buffer, Function, Unknown};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::JoinHandle;

pub(crate) const EVENT_QUEUE_CAPACITY: usize = 65_536;

#[napi(object)]
pub struct Capabilities {
    pub platform: String,
    pub kernel_release: String,
    pub io_uring_available: bool,
    pub accept: bool,
    pub accept_multi: bool,
    pub recv: bool,
    pub recv_multi: bool,
    pub provided_buffers: bool,
    pub provided_buffer_ring: bool,
    pub provided_buffer_ring_probe: String,
    pub recv_bundle: bool,
    pub send: bool,
    pub send_zc: bool,
    pub registered_send_buffer: bool,
    pub registered_send_buffer_probe: String,
    pub recv_zc: bool,
    pub zcrx_kernel_opcode: bool,
    pub zcrx_cqe32_ring: bool,
    pub zcrx_cqe32_ring_probe: String,
    pub zcrx_kernel_security_warnings: Vec<String>,
    pub fast_poll: bool,
    pub note: String,
}

#[napi(object)]
pub struct ZcrxProbeOptions {
    pub interface_name: Option<String>,
    pub rx_queue: Option<f64>,
    pub rx_buffer_size: Option<f64>,
    pub active_registration: Option<bool>,
}

#[napi(object)]
pub struct ZcrxProbe {
    pub interface_name: Option<String>,
    pub interface_index: u32,
    pub kernel_opcode: bool,
    pub interface_exists: bool,
    pub operstate: Option<String>,
    pub rx_queue: u32,
    pub rx_buffer_size: u32,
    pub rx_queue_count: u32,
    pub driver: Option<String>,
    pub is_loopback: bool,
    pub is_virtual: bool,
    pub ethtool_available: bool,
    pub header_data_split: String,
    pub flow_steering: String,
    pub active_registration: bool,
    pub active_registration_result: Option<String>,
    pub active_registration_errno: Option<i32>,
    pub kernel_security_warnings: Vec<String>,
    pub ready: bool,
    pub blockers: Vec<String>,
    pub note: String,
}

#[napi(object)]
pub struct ServerOptions {
    pub host: Option<String>,
    pub port: Option<f64>,
    pub backlog: Option<f64>,
    pub queue_depth: Option<f64>,
    pub buffer_count: Option<f64>,
    pub buffer_size: Option<f64>,
    pub max_connections: Option<f64>,
    pub idle_timeout_ms: Option<f64>,
    pub tcp_no_delay: Option<bool>,
    pub reuse_port: Option<bool>,
    pub tcp_defer_accept_seconds: Option<f64>,
    pub socket_recv_buffer_size: Option<f64>,
    pub socket_send_buffer_size: Option<f64>,
    pub response_body: Option<String>,
    pub use_registered_send_buffer: Option<bool>,
    pub use_recv_bundle: Option<bool>,
    pub use_zero_copy_send: Option<bool>,
    pub use_zero_copy_receive: Option<bool>,
    pub zcrx_interface_name: Option<String>,
    pub zcrx_rx_queue: Option<f64>,
    pub zcrx_rx_buffer_size: Option<f64>,
}

#[napi(object)]
pub struct TcpServerOptions {
    pub host: Option<String>,
    pub port: Option<f64>,
    pub backlog: Option<f64>,
    pub queue_depth: Option<f64>,
    pub buffer_count: Option<f64>,
    pub buffer_size: Option<f64>,
    pub max_connections: Option<f64>,
    pub idle_timeout_ms: Option<f64>,
    pub tcp_no_delay: Option<bool>,
    pub reuse_port: Option<bool>,
    pub tcp_defer_accept_seconds: Option<f64>,
    pub socket_recv_buffer_size: Option<f64>,
    pub socket_send_buffer_size: Option<f64>,
    pub command_queue_capacity: Option<f64>,
    pub event_queue_capacity: Option<f64>,
    pub event_batch_size: Option<f64>,
    pub send_queue_capacity: Option<f64>,
    pub use_registered_send_buffer: Option<bool>,
    pub use_recv_bundle: Option<bool>,
    pub use_zero_copy_send: Option<bool>,
    pub send_buffer_count: Option<f64>,
    pub send_buffer_size: Option<f64>,
    pub use_zero_copy_receive: Option<bool>,
    pub zcrx_interface_name: Option<String>,
    pub zcrx_rx_queue: Option<f64>,
    pub zcrx_rx_buffer_size: Option<f64>,
}

#[napi(object)]
#[derive(Clone)]
pub struct ServerInfo {
    pub host: String,
    pub port: u16,
    pub backend: String,
    pub backlog: u32,
    pub queue_depth: u32,
    pub buffer_count: u32,
    pub buffer_size: u32,
    pub max_connections: u32,
    pub rejected_connections: f64,
    pub idle_timeout_ms: u32,
    pub idle_timeouts: f64,
    pub tcp_no_delay: bool,
    pub reuse_port: bool,
    pub tcp_defer_accept_seconds: u32,
    pub socket_recv_buffer_size: u32,
    pub socket_send_buffer_size: u32,
    pub command_queue_capacity: u32,
    pub command_queue_drops: f64,
    pub event_queue_capacity: u32,
    pub event_queue_drops: f64,
    pub event_batch_size: u32,
    pub send_queue_capacity: u32,
    pub send_queue_drops: f64,
    pub send_buffer_count: u32,
    pub send_buffer_size: u32,
    pub active_connections: f64,
    pub accepted_connections: f64,
    pub closed_connections: f64,
    pub bytes_received: f64,
    pub bytes_sent: f64,
    pub multishot_accept: bool,
    pub multishot_recv: bool,
    pub provided_buffer_ring: bool,
    pub recv_bundle: bool,
    pub recv_bundle_completions: f64,
    pub recv_bundle_buffers: f64,
    pub recv_bundle_bytes: f64,
    pub recv_buffer_starvations: f64,
    pub recv_multishot_resubmits: f64,
    pub recv_copy_events: f64,
    pub recv_copy_bytes: f64,
    pub registered_send_buffer: bool,
    pub registered_send_requests: f64,
    pub registered_send_errors: f64,
    pub fixed_send_buffer_misses: f64,
    pub fixed_send_buffer_miss_bytes: f64,
    pub zero_copy_send: bool,
    pub zero_copy_send_requests: f64,
    pub zero_copy_send_notifications: f64,
    pub zero_copy_send_copied: f64,
    pub zero_copy_send_errors: f64,
    pub zero_copy_receive: bool,
    pub zcrx_ready: bool,
    pub zcrx_rx_buffer_size: u32,
    pub zcrx_packets: f64,
    pub zcrx_bytes: f64,
}

#[napi(object)]
pub struct TcpEvent {
    pub event_type: String,
    pub connection_id: u32,
    pub remote_addr: Option<String>,
    pub remote_address: Option<String>,
    pub remote_family: Option<String>,
    pub remote_port: Option<u16>,
    pub data: Option<Buffer>,
}

#[napi(object)]
pub struct TcpSend {
    pub connection_id: f64,
    pub data: Buffer,
}

pub(crate) type TcpEventCallback = ThreadsafeFunction<
    TcpEvent,
    Unknown<'static>,
    TcpEvent,
    Status,
    false,
    false,
    EVENT_QUEUE_CAPACITY,
>;
pub(crate) type TcpEventBatchCallback = ThreadsafeFunction<
    Vec<TcpEvent>,
    Unknown<'static>,
    Vec<TcpEvent>,
    Status,
    false,
    false,
    EVENT_QUEUE_CAPACITY,
>;

pub(crate) enum TcpEventSink {
    None,
    Single(TcpEventCallback),
    Batch(TcpEventBatchCallback),
}

struct NativeServer {
    info: ServerInfo,
    stats: Arc<uring::TransportStats>,
    shutdown: Arc<AtomicBool>,
    command_event_fd: RawFd,
    join: Option<JoinHandle<()>>,
}

impl NativeServer {
    fn wake(&self) {
        wake_event_fd(self.command_event_fd);
    }

    fn info(&self) -> ServerInfo {
        let mut info = self.info.clone();
        self.stats.apply_to_info(&mut info);
        info
    }

    fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.wake();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        if self.command_event_fd >= 0 {
            // SAFETY: command_event_fd is owned by this server handle after the
            // worker has joined, and the fd is set to -1 immediately after close.
            unsafe {
                libc::close(self.command_event_fd);
            }
            self.command_event_fd = -1;
        }
    }
}

impl Drop for NativeServer {
    fn drop(&mut self) {
        self.stop();
    }
}

struct TcpNativeServer {
    info: ServerInfo,
    stats: Arc<uring::TransportStats>,
    shutdown: Arc<AtomicBool>,
    command_tx: SyncSender<uring::TcpCommand>,
    command_event_fd: RawFd,
    join: Option<JoinHandle<()>>,
}

impl TcpNativeServer {
    fn wake(&self) {
        wake_event_fd(self.command_event_fd);
    }

    fn info(&self) -> ServerInfo {
        let mut info = self.info.clone();
        self.stats.apply_to_info(&mut info);
        info
    }

    fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.wake();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        if self.command_event_fd >= 0 {
            // SAFETY: command_event_fd is owned by this server handle after the
            // worker has joined, and the fd is set to -1 immediately after close.
            unsafe {
                libc::close(self.command_event_fd);
            }
            self.command_event_fd = -1;
        }
    }

    fn enqueue_command(&self, command: uring::TcpCommand) -> Result<bool> {
        match self.command_tx.try_send(command) {
            Ok(()) => {
                self.wake();
                Ok(true)
            }
            Err(TrySendError::Full(_)) => {
                self.stats.record_command_queue_drop();
                Ok(false)
            }
            Err(TrySendError::Disconnected(_)) => Err(Error::new(
                Status::GenericFailure,
                "TCP worker command queue is disconnected".to_string(),
            )),
        }
    }
}

impl Drop for TcpNativeServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[napi]
pub struct UringHttpServer {
    options: uring::ServerConfig,
    server: Option<NativeServer>,
}

#[napi]
impl UringHttpServer {
    #[napi(constructor)]
    pub fn new(options: Option<ServerOptions>) -> Result<Self> {
        Ok(Self {
            options: uring::ServerConfig::from_options(options).map_err(to_napi_error)?,
            server: None,
        })
    }

    #[napi]
    pub fn start(&mut self) -> Result<ServerInfo> {
        if self.server.is_some() {
            return Err(Error::new(
                Status::InvalidArg,
                "server is already running".to_string(),
            ));
        }

        let started = uring::start_server(self.options.clone()).map_err(to_napi_error)?;
        let info = started.info.clone();
        self.server = Some(NativeServer {
            info: started.info,
            stats: started.stats,
            shutdown: started.shutdown,
            command_event_fd: started.command_event_fd,
            join: Some(started.join),
        });
        Ok(info)
    }

    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        if let Some(server) = &mut self.server {
            server.stop();
        }
        self.server = None;
        Ok(())
    }

    #[napi]
    pub fn info(&self) -> Option<ServerInfo> {
        self.server.as_ref().map(|server| server.info())
    }
}

#[napi]
pub struct UringTcpServer {
    options: uring::TcpServerConfig,
    server: Option<TcpNativeServer>,
}

#[napi]
pub struct UringTcpEchoServer {
    options: uring::TcpServerConfig,
    server: Option<NativeServer>,
}

#[napi]
impl UringTcpServer {
    #[napi(constructor)]
    pub fn new(options: Option<TcpServerOptions>) -> Result<Self> {
        Ok(Self {
            options: uring::TcpServerConfig::from_options(options).map_err(to_napi_error)?,
            server: None,
        })
    }

    #[napi]
    pub fn start(
        &mut self,
        event_callback: Function<'_, TcpEvent, Unknown<'static>>,
    ) -> Result<ServerInfo> {
        let event_callback: TcpEventCallback = event_callback
            .build_threadsafe_function::<TcpEvent>()
            .callee_handled::<false>()
            .max_queue_size::<EVENT_QUEUE_CAPACITY>()
            .build_callback(|context| Ok(context.value))?;
        self.start_with_sink(TcpEventSink::Single(event_callback))
    }

    #[napi(js_name = "startBatch")]
    pub fn start_batch(
        &mut self,
        event_callback: Function<'_, Vec<TcpEvent>, Unknown<'static>>,
    ) -> Result<ServerInfo> {
        let event_callback: TcpEventBatchCallback = event_callback
            .build_threadsafe_function::<Vec<TcpEvent>>()
            .callee_handled::<false>()
            .max_queue_size::<EVENT_QUEUE_CAPACITY>()
            .build_callback(|context| Ok(context.value))?;
        self.start_with_sink(TcpEventSink::Batch(event_callback))
    }

    fn start_with_sink(&mut self, event_sink: TcpEventSink) -> Result<ServerInfo> {
        if self.server.is_some() {
            return Err(Error::new(
                Status::InvalidArg,
                "server is already running".to_string(),
            ));
        }

        let started =
            uring::start_tcp_server(self.options.clone(), event_sink).map_err(to_napi_error)?;
        let info = started.info.clone();
        self.server = Some(TcpNativeServer {
            info: started.info,
            stats: started.stats,
            shutdown: started.shutdown,
            command_tx: started.command_tx,
            command_event_fd: started.command_event_fd,
            join: Some(started.join),
        });
        Ok(info)
    }

    #[napi]
    pub fn send(&self, connection_id: f64, data: Buffer) -> Result<bool> {
        let connection_id = validate_connection_id(connection_id)?;
        let Some(server) = &self.server else {
            return Ok(false);
        };
        let data = Vec::<u8>::from(data);
        server.enqueue_command(uring::TcpCommand::Send {
            connection_id,
            data,
        })
    }

    #[napi(js_name = "sendAndClose")]
    pub fn send_and_close(&self, connection_id: f64, data: Buffer) -> Result<bool> {
        let connection_id = validate_connection_id(connection_id)?;
        let Some(server) = &self.server else {
            return Ok(false);
        };
        server.enqueue_command(uring::TcpCommand::SendAndClose {
            connection_id,
            data: Vec::<u8>::from(data),
        })
    }

    #[napi(js_name = "sendBatch")]
    pub fn send_batch(&self, sends: Vec<TcpSend>) -> Result<bool> {
        let sends = validate_tcp_sends(sends)?;
        let Some(server) = &self.server else {
            return Ok(false);
        };
        if sends.is_empty() {
            return Ok(true);
        }

        let sends = sends
            .into_iter()
            .map(|(connection_id, data)| uring::TcpSendCommand {
                connection_id,
                data: Vec::<u8>::from(data),
            })
            .collect();
        server.enqueue_command(uring::TcpCommand::SendBatch { sends })
    }

    #[napi(js_name = "sendBatchAndClose")]
    pub fn send_batch_and_close(&self, sends: Vec<TcpSend>) -> Result<bool> {
        let sends = validate_tcp_sends(sends)?;
        let Some(server) = &self.server else {
            return Ok(false);
        };
        if sends.is_empty() {
            return Ok(true);
        }

        let sends = sends
            .into_iter()
            .map(|(connection_id, data)| uring::TcpSendCommand {
                connection_id,
                data: Vec::<u8>::from(data),
            })
            .collect();
        server.enqueue_command(uring::TcpCommand::SendBatchAndClose { sends })
    }

    #[napi(js_name = "closeConnection")]
    pub fn close_connection(&self, connection_id: f64) -> Result<bool> {
        let connection_id = validate_connection_id(connection_id)?;
        let Some(server) = &self.server else {
            return Ok(false);
        };
        server.enqueue_command(uring::TcpCommand::Close { connection_id })
    }

    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        if let Some(server) = &mut self.server {
            server.stop();
        }
        self.server = None;
        Ok(())
    }

    #[napi]
    pub fn info(&self) -> Option<ServerInfo> {
        self.server.as_ref().map(|server| server.info())
    }
}

#[napi]
impl UringTcpEchoServer {
    #[napi(constructor)]
    pub fn new(options: Option<TcpServerOptions>) -> Result<Self> {
        Ok(Self {
            options: uring::TcpServerConfig::from_options(options).map_err(to_napi_error)?,
            server: None,
        })
    }

    #[napi]
    pub fn start(&mut self) -> Result<ServerInfo> {
        if self.server.is_some() {
            return Err(Error::new(
                Status::InvalidArg,
                "server is already running".to_string(),
            ));
        }

        let started = uring::start_tcp_echo_server(self.options.clone()).map_err(to_napi_error)?;
        let info = started.info.clone();
        self.server = Some(NativeServer {
            info: started.info,
            stats: started.stats,
            shutdown: started.shutdown,
            command_event_fd: started.command_event_fd,
            join: Some(started.join),
        });
        Ok(info)
    }

    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        if let Some(server) = &mut self.server {
            server.stop();
        }
        self.server = None;
        Ok(())
    }

    #[napi]
    pub fn info(&self) -> Option<ServerInfo> {
        self.server.as_ref().map(|server| server.info())
    }
}

#[napi]
pub fn capabilities() -> Capabilities {
    uring::capabilities()
}

#[napi(js_name = "zcrxProbe")]
pub fn zcrx_probe(options: Option<ZcrxProbeOptions>) -> Result<ZcrxProbe> {
    Ok(uring::zcrx_probe(validate_zcrx_probe_options(options)?))
}

fn to_napi_error(error: uring::UringError) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

fn validate_zcrx_probe_options(
    options: Option<ZcrxProbeOptions>,
) -> Result<uring::ZcrxProbeConfig> {
    let Some(options) = options else {
        return Ok(uring::ZcrxProbeConfig::default());
    };

    if options
        .interface_name
        .as_ref()
        .is_some_and(|interface_name| interface_name.is_empty())
    {
        return Err(Error::new(
            Status::InvalidArg,
            "zcrxProbe interfaceName must be a non-empty string".to_string(),
        ));
    }

    Ok(uring::ZcrxProbeConfig {
        interface_name: options.interface_name,
        rx_queue: validate_optional_u32_number("zcrxProbe rxQueue", options.rx_queue)?,
        rx_buffer_size: validate_optional_u32_number(
            "zcrxProbe rxBufferSize",
            options.rx_buffer_size,
        )?,
        active_registration: options.active_registration,
    })
}

fn validate_tcp_sends(sends: Vec<TcpSend>) -> Result<Vec<(u32, Buffer)>> {
    sends
        .into_iter()
        .map(|send| Ok((validate_connection_id(send.connection_id)?, send.data)))
        .collect()
}

fn validate_connection_id(value: f64) -> Result<u32> {
    validate_u32_number("connectionId", value)
}

fn validate_optional_u32_number(name: &str, value: Option<f64>) -> Result<Option<u32>> {
    value.map(|raw| validate_u32_number(name, raw)).transpose()
}

fn validate_u32_number(name: &str, value: f64) -> Result<u32> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > u32::MAX as f64 {
        return Err(Error::new(
            Status::InvalidArg,
            format!("{name} must be an integer between 0 and {}", u32::MAX),
        ));
    }
    Ok(value as u32)
}

fn wake_event_fd(fd: RawFd) {
    let value = 1_u64;
    // SAFETY: fd is an eventfd created by the native startup path, and the
    // write buffer points to a valid u64 for the full syscall duration.
    unsafe {
        let _ = libc::write(
            fd,
            (&value as *const u64).cast::<libc::c_void>(),
            std::mem::size_of::<u64>(),
        );
    }
}
