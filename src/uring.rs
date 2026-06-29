use crate::{
    Capabilities, ServerInfo, ServerOptions, TcpEvent, TcpEventCallback, TcpEventSink,
    TcpServerOptions, ZcrxProbe, EVENT_QUEUE_CAPACITY,
};
use io_uring::cqueue;
use io_uring::opcode;
use io_uring::register::Probe;
use io_uring::squeue;
use io_uring::types::{self, SubmitArgs, Timespec};
use io_uring::IoUring;
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::Status;
use std::collections::{HashMap, VecDeque};
use std::ffi::CString;
use std::fmt;
use std::fs;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, ToSocketAddrs};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr::NonNull;
use std::sync::atomic::{fence, AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const BGID: u16 = 7;
const OP_ACCEPT: u8 = 1;
const OP_RECV: u8 = 2;
const OP_SEND: u8 = 3;
const OP_PROVIDE: u8 = 4;
const OP_COMMAND: u8 = 5;
const DEFAULT_QUEUE_DEPTH: u32 = 64;
const DEFAULT_BACKLOG: u32 = 1024;
const DEFAULT_BUFFER_COUNT: u32 = 512;
const DEFAULT_BUFFER_SIZE: u32 = 2048;
const DEFAULT_SEND_BUFFER_COUNT: u32 = 256;
const DEFAULT_SEND_BUFFER_SIZE: u32 = 2048;
const DEFAULT_COMMAND_QUEUE_CAPACITY: u32 = 65_536;
const DEFAULT_EVENT_QUEUE_CAPACITY: u32 = EVENT_QUEUE_CAPACITY as u32;
const DEFAULT_SEND_QUEUE_CAPACITY: u32 = 1024;
const DEFAULT_EVENT_BATCH_SIZE: u32 = 64;
const HALF_CLOSE_RESPONSE_GRACE_TICKS: u8 = 5;
const SHUTDOWN_SEND_DRAIN_TICKS: usize = 4;
const DEFAULT_RESPONSE_BODY: &str = "hello from ferrings\n";
const DEFAULT_ZCRX_RX_BUFFER_SIZE: u32 = 0;
// linux/io_uring.h: use registered buffers for SEND/RECV via sqe.buf_index.
const RECVSEND_FIXED_BUF: u16 = 1 << 2;
// linux/io_uring.h: ask SEND_ZC notifications to report whether the kernel copied.
const SEND_ZC_REPORT_USAGE: u16 = 1 << 3;
const NOTIF_USAGE_ZC_COPIED: u32 = 1 << 31;
const IORING_REGISTER_ZCRX_IFQ: libc::c_uint = 32;
const IORING_MEM_REGION_TYPE_USER: u32 = 1;
const IORING_CQE_F_SKIP: u32 = 1 << 5;
const ZCRX_PROBE_RQ_ENTRIES: u32 = 64;
const ZCRX_PROBE_BUFFER_SIZE: usize = 4096;
const ZCRX_AREA_OFFSET_BITS: u32 = 48;
const ZCRX_AREA_OFFSET_MASK: u64 = (1_u64 << ZCRX_AREA_OFFSET_BITS) - 1;
const ZCRX_KERNEL_SECURITY_OVERRIDE_ENV: &str = "FERRINGS_ZCRX_ALLOW_KERNEL_SECURITY_RISK";
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

type Ring<C = cqueue::Entry> = IoUring<squeue::Entry, C>;
type ZcrxRing = Ring<cqueue::Entry32>;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct IoUringZcrxOffsets {
    head: u32,
    tail: u32,
    rqes: u32,
    __resv2: u32,
    __resv: [u64; 2],
}

#[repr(C)]
#[derive(Default)]
struct IoUringZcrxAreaReg {
    addr: u64,
    len: u64,
    rq_area_token: u64,
    flags: u32,
    dmabuf_fd: u32,
    __resv2: [u64; 2],
}

#[repr(C)]
#[derive(Default)]
struct IoUringRegionDesc {
    user_addr: u64,
    size: u64,
    flags: u32,
    id: u32,
    mmap_offset: u64,
    __resv: [u64; 4],
}

#[repr(C)]
#[derive(Default)]
struct IoUringZcrxIfqReg {
    if_idx: u32,
    if_rxq: u32,
    rq_entries: u32,
    flags: u32,
    area_ptr: u64,
    region_ptr: u64,
    offsets: IoUringZcrxOffsets,
    zcrx_id: u32,
    rx_buf_len: u32,
    __resv: [u64; 3],
}

#[repr(C)]
struct IoUringZcrxRqe {
    off: u64,
    len: u32,
    __pad: u32,
}

struct ZcrxActiveProbeResult {
    message: String,
    errno: Option<i32>,
    success: bool,
}

#[repr(C)]
struct SqeFixedBufferPrefix {
    opcode: u8,
    flags: u8,
    ioprio: u16,
    fd: i32,
    off: u64,
    addr: u64,
    len: u32,
    msg_flags: u32,
    user_data: u64,
    buf_index: u16,
}

struct ZcrxRegistrationResult {
    registration: ZcrxRegistration,
    fallback_from_rx_buffer_size: Option<(u32, String)>,
}

struct ZcrxRegistrationError {
    stage: &'static str,
    error: io::Error,
}

impl ZcrxRegistrationError {
    fn new(stage: &'static str, error: io::Error) -> Self {
        Self { stage, error }
    }

    fn errno(&self) -> Option<i32> {
        self.error.raw_os_error()
    }
}

impl fmt::Display for ZcrxRegistrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.stage, self.error)
    }
}

struct MappedRegion {
    ptr: NonNull<libc::c_void>,
    len: usize,
}

impl MappedRegion {
    fn new(len: usize) -> io::Result<Self> {
        // SAFETY: mmap is called with an anonymous private mapping, a null hint,
        // and fd -1/offset 0 as required for MAP_ANONYMOUS. The returned
        // pointer is checked against MAP_FAILED before it is stored.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_ANONYMOUS | libc::MAP_PRIVATE,
                -1,
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }

        let ptr =
            NonNull::new(ptr).ok_or_else(|| io::Error::other("mmap returned a null pointer"))?;
        Ok(Self { ptr, len })
    }

    fn addr(&self) -> u64 {
        self.ptr.as_ptr() as usize as u64
    }

    fn at<T>(&self, offset: u32) -> *mut T {
        // SAFETY: callers only pass kernel-provided offsets into this mapped
        // region and perform the typed access that matches the ZCRX structure at
        // that offset. This helper only computes the raw address.
        unsafe {
            self.ptr
                .as_ptr()
                .cast::<u8>()
                .add(offset as usize)
                .cast::<T>()
        }
    }
}

impl Drop for MappedRegion {
    fn drop(&mut self) {
        // SAFETY: ptr/len came from a successful mmap in MappedRegion::new and
        // this type owns the mapping until Drop.
        unsafe {
            libc::munmap(self.ptr.as_ptr(), self.len);
        }
    }
}

struct ZcrxRegistration {
    area: MappedRegion,
    refill_queue: MappedRegion,
    offsets: IoUringZcrxOffsets,
    zcrx_id: u32,
    rx_buffer_size: u32,
    rq_entries: u32,
    rq_area_token: u64,
    primed_refills: u32,
}

#[derive(Clone, Copy, Debug)]
struct ZcrxPacket {
    offset: u64,
    len: u32,
}

impl ZcrxRegistration {
    fn register(
        ring: &ZcrxRing,
        interface_index: u32,
        rx_queue: u32,
        rq_entries: u32,
        rx_buffer_size_hint: u32,
    ) -> Result<Self, ZcrxRegistrationError> {
        debug_assert!(rq_entries.is_power_of_two());
        let page_size = page_size().unwrap_or(4096);
        let requested_rx_buffer_size = rx_buffer_size_hint as usize;
        let allocation_rx_buffer_size = if requested_rx_buffer_size == 0 {
            page_size
        } else {
            requested_rx_buffer_size
        };
        let area_len = align_to_page(rq_entries as usize * allocation_rx_buffer_size, page_size);
        let rq_len = align_to_page(
            page_size + rq_entries as usize * std::mem::size_of::<IoUringZcrxRqe>(),
            page_size,
        );

        let area = MappedRegion::new(area_len)
            .map_err(|error| ZcrxRegistrationError::new("allocate receive area", error))?;
        let refill_queue = MappedRegion::new(rq_len)
            .map_err(|error| ZcrxRegistrationError::new("allocate refill queue", error))?;

        let mut area_reg = IoUringZcrxAreaReg {
            addr: area.addr(),
            len: area_len as u64,
            ..Default::default()
        };
        let mut region = IoUringRegionDesc {
            user_addr: refill_queue.addr(),
            size: rq_len as u64,
            flags: IORING_MEM_REGION_TYPE_USER,
            ..Default::default()
        };
        let mut ifq_reg = IoUringZcrxIfqReg {
            if_idx: interface_index,
            if_rxq: rx_queue,
            rq_entries,
            area_ptr: (&mut area_reg as *mut IoUringZcrxAreaReg) as usize as u64,
            region_ptr: (&mut region as *mut IoUringRegionDesc) as usize as u64,
            rx_buf_len: rx_buffer_size_hint,
            ..Default::default()
        };

        // SAFETY: the io_uring fd is owned by `ring`, and the registration
        // payload pointers reference stack values that remain alive for the
        // duration of the syscall. The kernel copies/fills them before return.
        let ret = unsafe {
            libc::syscall(
                libc::SYS_io_uring_register,
                ring.as_raw_fd(),
                IORING_REGISTER_ZCRX_IFQ,
                (&mut ifq_reg as *mut IoUringZcrxIfqReg).cast::<libc::c_void>(),
                1_u32,
            )
        };
        if ret < 0 {
            return Err(ZcrxRegistrationError::new(
                "register ZCRX ifq",
                io::Error::last_os_error(),
            ));
        }

        let effective_rx_buffer_size = if ifq_reg.rx_buf_len == 0 {
            allocation_rx_buffer_size as u32
        } else {
            ifq_reg.rx_buf_len
        };
        let mut registration = Self {
            area,
            refill_queue,
            offsets: ifq_reg.offsets,
            zcrx_id: ifq_reg.zcrx_id,
            rx_buffer_size: effective_rx_buffer_size,
            rq_entries,
            rq_area_token: area_reg.rq_area_token,
            primed_refills: 0,
        };
        registration
            .prime_refill_queue()
            .map_err(|error| ZcrxRegistrationError::new("prime refill queue", error))?;
        Ok(registration)
    }

    fn register_with_default_fallback(
        ring: &ZcrxRing,
        interface_index: u32,
        rx_queue: u32,
        rq_entries: u32,
        rx_buffer_size_hint: u32,
    ) -> Result<ZcrxRegistrationResult, ZcrxRegistrationError> {
        match Self::register(
            ring,
            interface_index,
            rx_queue,
            rq_entries,
            rx_buffer_size_hint,
        ) {
            Ok(registration) => Ok(ZcrxRegistrationResult {
                registration,
                fallback_from_rx_buffer_size: None,
            }),
            Err(error) if rx_buffer_size_hint != 0 => {
                let first_error = error.to_string();
                let registration = Self::register(ring, interface_index, rx_queue, rq_entries, 0)?;
                Ok(ZcrxRegistrationResult {
                    registration,
                    fallback_from_rx_buffer_size: Some((rx_buffer_size_hint, first_error)),
                })
            }
            Err(error) => Err(error),
        }
    }

    fn prime_refill_queue(&mut self) -> io::Result<()> {
        for index in 0..self.rq_entries {
            let offset = index as u64 * self.rx_buffer_size as u64;
            self.recycle(offset, self.rx_buffer_size)?;
        }
        Ok(())
    }

    fn recycle(&mut self, packet_offset: u64, len: u32) -> io::Result<()> {
        // SAFETY: offsets were returned by successful ZCRX IFQ registration and
        // point into the mapped refill_queue region for the queue lifetime.
        let head = unsafe {
            (*self
                .refill_queue
                .at::<std::sync::atomic::AtomicU32>(self.offsets.head))
            .load(Ordering::Acquire)
        };
        let tail_ptr = self
            .refill_queue
            .at::<std::sync::atomic::AtomicU32>(self.offsets.tail);
        // SAFETY: tail_ptr is derived from the kernel-provided tail offset into
        // the live refill_queue mapping and is used as the documented atomic u32.
        let tail = unsafe { (*tail_ptr).load(Ordering::Acquire) };
        if tail.wrapping_sub(head) >= self.rq_entries {
            return Err(io::Error::other("ZCRX refill queue is full"));
        }

        let slot = tail & (self.rq_entries - 1);
        // SAFETY: slot is masked by rq_entries - 1, rq_entries is a power of
        // two, and offsets.rqes points at the RQE array in refill_queue.
        let rqe = unsafe {
            self.refill_queue
                .at::<IoUringZcrxRqe>(self.offsets.rqes)
                .add(slot as usize)
        };
        // SAFETY: rqe points at the free slot selected above; tail is only
        // published after the RQE write and release fence.
        unsafe {
            rqe.write(IoUringZcrxRqe {
                off: (packet_offset & ZCRX_AREA_OFFSET_MASK) | self.rq_area_token,
                len,
                __pad: 0,
            });
            fence(Ordering::Release);
            (*tail_ptr).store(tail.wrapping_add(1), Ordering::Release);
        }
        self.primed_refills = self.primed_refills.saturating_add(1);
        Ok(())
    }

    #[allow(dead_code)]
    fn decode_packet(&self, cqe: &cqueue::Entry32) -> Result<Option<ZcrxPacket>, UringError> {
        let result = cqe.result();
        if result < 0 {
            return Err(io::Error::from_raw_os_error(-result).into());
        }
        if result == 0 {
            return Ok(None);
        }

        let packet_offset = cqe.big_cqe()[0] & ZCRX_AREA_OFFSET_MASK;
        let len = result as u32;
        let end = packet_offset
            .checked_add(len as u64)
            .ok_or_else(|| UringError("ZCRX packet offset overflowed".to_string()))?;
        if end > self.area.len as u64 {
            return Err(format!(
                "ZCRX packet range {packet_offset}..{end} is outside registered receive area {}",
                self.area.len
            )
            .into());
        }

        Ok(Some(ZcrxPacket {
            offset: packet_offset,
            len,
        }))
    }

    #[allow(dead_code)]
    fn packet_bytes(&self, packet: ZcrxPacket) -> &[u8] {
        // SAFETY: decode_packet validates packet.offset..offset+len is inside
        // the registered receive area before packets are exposed to callers.
        unsafe {
            std::slice::from_raw_parts(
                self.area
                    .ptr
                    .as_ptr()
                    .cast::<u8>()
                    .add(packet.offset as usize),
                packet.len as usize,
            )
        }
    }

    #[allow(dead_code)]
    fn recycle_packet(&mut self, packet: ZcrxPacket) -> Result<(), UringError> {
        self.recycle(packet.offset, packet.len)
            .map_err(UringError::from)
    }

    fn receive_area_len(&self) -> usize {
        self.area.len
    }

    fn refill_queue_len(&self) -> usize {
        self.refill_queue.len
    }
}

#[derive(Debug)]
pub struct UringError(String);

impl fmt::Display for UringError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<io::Error> for UringError {
    fn from(value: io::Error) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for UringError {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[derive(Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub backlog: u32,
    pub queue_depth: u32,
    pub buffer_count: u32,
    pub buffer_size: u32,
    pub max_connections: u32,
    pub idle_timeout_ms: u32,
    pub tcp_no_delay: bool,
    pub reuse_port: bool,
    pub tcp_defer_accept_seconds: u32,
    pub socket_recv_buffer_size: u32,
    pub socket_send_buffer_size: u32,
    pub response_body: Vec<u8>,
    pub use_registered_send_buffer: bool,
    pub use_recv_bundle: bool,
    pub use_zero_copy_send: bool,
    pub use_zero_copy_receive: bool,
    pub zcrx_interface_name: Option<String>,
    pub zcrx_rx_queue: Option<u32>,
    pub zcrx_rx_buffer_size: u32,
}

impl ServerConfig {
    pub fn from_options(options: Option<ServerOptions>) -> Result<Self, UringError> {
        let options = options.unwrap_or(ServerOptions {
            host: None,
            port: None,
            backlog: None,
            queue_depth: None,
            buffer_count: None,
            buffer_size: None,
            max_connections: None,
            idle_timeout_ms: None,
            tcp_no_delay: None,
            reuse_port: None,
            tcp_defer_accept_seconds: None,
            socket_recv_buffer_size: None,
            socket_send_buffer_size: None,
            response_body: None,
            use_registered_send_buffer: None,
            use_recv_bundle: None,
            use_zero_copy_send: None,
            use_zero_copy_receive: None,
            zcrx_interface_name: None,
            zcrx_rx_queue: None,
            zcrx_rx_buffer_size: None,
        });

        let buffer_count = validate_u32_option(
            "bufferCount",
            options.buffer_count,
            DEFAULT_BUFFER_COUNT,
            1,
            32768,
        )?;
        if !buffer_count.is_power_of_two() {
            return Err("bufferCount must be a non-zero power of two"
                .to_string()
                .into());
        }

        let buffer_size = validate_u32_option(
            "bufferSize",
            options.buffer_size,
            DEFAULT_BUFFER_SIZE,
            512,
            u32::MAX,
        )?;

        let mut response_body = options
            .response_body
            .unwrap_or_else(|| DEFAULT_RESPONSE_BODY.to_string())
            .into_bytes();
        if response_body.is_empty() {
            response_body.extend_from_slice(DEFAULT_RESPONSE_BODY.as_bytes());
        }
        let use_recv_bundle = options.use_recv_bundle.unwrap_or(false);
        let use_zero_copy_receive = options.use_zero_copy_receive.unwrap_or(false);
        if use_recv_bundle && use_zero_copy_receive {
            return Err(
                "useRecvBundle is only available on the provided-buffer receive path, not ZCRX"
                    .to_string()
                    .into(),
            );
        }

        Ok(Self {
            host: options.host.unwrap_or_else(|| "127.0.0.1".to_string()),
            port: validate_port(options.port)?,
            backlog: validate_backlog(options.backlog)?,
            queue_depth: validate_queue_depth(options.queue_depth)?,
            buffer_count,
            buffer_size,
            max_connections: validate_u32_option(
                "maxConnections",
                options.max_connections,
                0,
                0,
                u32::MAX,
            )?,
            idle_timeout_ms: validate_u32_option(
                "idleTimeoutMs",
                options.idle_timeout_ms,
                0,
                0,
                u32::MAX,
            )?,
            tcp_no_delay: options.tcp_no_delay.unwrap_or(true),
            reuse_port: options.reuse_port.unwrap_or(false),
            tcp_defer_accept_seconds: validate_tcp_defer_accept_seconds(
                options.tcp_defer_accept_seconds,
            )?,
            socket_recv_buffer_size: validate_socket_buffer_size(
                "socketRecvBufferSize",
                options.socket_recv_buffer_size,
            )?,
            socket_send_buffer_size: validate_socket_buffer_size(
                "socketSendBufferSize",
                options.socket_send_buffer_size,
            )?,
            response_body,
            use_registered_send_buffer: options.use_registered_send_buffer.unwrap_or(false),
            use_recv_bundle,
            use_zero_copy_send: options.use_zero_copy_send.unwrap_or(false),
            use_zero_copy_receive,
            zcrx_interface_name: options.zcrx_interface_name,
            zcrx_rx_queue: validate_optional_u32("zcrxRxQueue", options.zcrx_rx_queue)?,
            zcrx_rx_buffer_size: validate_zcrx_rx_buffer_size(options.zcrx_rx_buffer_size)?,
        })
    }
}

#[derive(Clone)]
pub struct TcpServerConfig {
    pub host: String,
    pub port: u16,
    pub backlog: u32,
    pub queue_depth: u32,
    pub buffer_count: u32,
    pub buffer_size: u32,
    pub max_connections: u32,
    pub idle_timeout_ms: u32,
    pub tcp_no_delay: bool,
    pub reuse_port: bool,
    pub tcp_defer_accept_seconds: u32,
    pub socket_recv_buffer_size: u32,
    pub socket_send_buffer_size: u32,
    pub command_queue_capacity: u32,
    pub event_queue_capacity: u32,
    pub event_batch_size: u32,
    pub send_queue_capacity: u32,
    pub use_registered_send_buffer: bool,
    pub use_recv_bundle: bool,
    pub use_zero_copy_send: bool,
    pub send_buffer_count: u32,
    pub send_buffer_size: u32,
    pub use_zero_copy_receive: bool,
    pub zcrx_interface_name: Option<String>,
    pub zcrx_rx_queue: Option<u32>,
    pub zcrx_rx_buffer_size: u32,
}

impl TcpServerConfig {
    pub fn from_options(options: Option<TcpServerOptions>) -> Result<Self, UringError> {
        let options = options.unwrap_or(TcpServerOptions {
            host: None,
            port: None,
            backlog: None,
            queue_depth: None,
            buffer_count: None,
            buffer_size: None,
            max_connections: None,
            idle_timeout_ms: None,
            tcp_no_delay: None,
            reuse_port: None,
            tcp_defer_accept_seconds: None,
            socket_recv_buffer_size: None,
            socket_send_buffer_size: None,
            command_queue_capacity: None,
            event_queue_capacity: None,
            event_batch_size: None,
            send_queue_capacity: None,
            use_registered_send_buffer: None,
            use_recv_bundle: None,
            use_zero_copy_send: None,
            send_buffer_count: None,
            send_buffer_size: None,
            use_zero_copy_receive: None,
            zcrx_interface_name: None,
            zcrx_rx_queue: None,
            zcrx_rx_buffer_size: None,
        });

        let buffer_count = validate_u32_option(
            "bufferCount",
            options.buffer_count,
            DEFAULT_BUFFER_COUNT,
            1,
            32768,
        )?;
        if !buffer_count.is_power_of_two() {
            return Err("bufferCount must be a non-zero power of two"
                .to_string()
                .into());
        }

        let buffer_size = validate_u32_option(
            "bufferSize",
            options.buffer_size,
            DEFAULT_BUFFER_SIZE,
            512,
            u32::MAX,
        )?;

        let send_buffer_count = validate_u32_option(
            "sendBufferCount",
            options.send_buffer_count,
            DEFAULT_SEND_BUFFER_COUNT,
            1,
            u16::MAX as u32,
        )?;

        let send_buffer_size = validate_u32_option(
            "sendBufferSize",
            options.send_buffer_size,
            DEFAULT_SEND_BUFFER_SIZE,
            64,
            u32::MAX,
        )?;

        let command_queue_capacity = validate_nonzero_u32_option(
            "commandQueueCapacity",
            options.command_queue_capacity,
            DEFAULT_COMMAND_QUEUE_CAPACITY,
            "commandQueueCapacity must be at least 1",
        )?;

        let event_queue_capacity = validate_event_queue_capacity(options.event_queue_capacity)?;
        let event_batch_size = options
            .event_batch_size
            .map(|value| validate_event_batch_size(value, event_queue_capacity))
            .transpose()?
            .unwrap_or_else(|| DEFAULT_EVENT_BATCH_SIZE.min(event_queue_capacity));
        let send_queue_capacity = validate_nonzero_u32_option(
            "sendQueueCapacity",
            options.send_queue_capacity,
            DEFAULT_SEND_QUEUE_CAPACITY,
            "sendQueueCapacity must be at least 1",
        )?;

        let use_recv_bundle = options.use_recv_bundle.unwrap_or(false);
        let use_zero_copy_receive = options.use_zero_copy_receive.unwrap_or(false);
        if use_recv_bundle && use_zero_copy_receive {
            return Err(
                "useRecvBundle is only available on the provided-buffer receive path, not ZCRX"
                    .to_string()
                    .into(),
            );
        }

        Ok(Self {
            host: options.host.unwrap_or_else(|| "127.0.0.1".to_string()),
            port: validate_port(options.port)?,
            backlog: validate_backlog(options.backlog)?,
            queue_depth: validate_queue_depth(options.queue_depth)?,
            buffer_count,
            buffer_size,
            max_connections: validate_u32_option(
                "maxConnections",
                options.max_connections,
                0,
                0,
                u32::MAX,
            )?,
            idle_timeout_ms: validate_u32_option(
                "idleTimeoutMs",
                options.idle_timeout_ms,
                0,
                0,
                u32::MAX,
            )?,
            tcp_no_delay: options.tcp_no_delay.unwrap_or(true),
            reuse_port: options.reuse_port.unwrap_or(false),
            tcp_defer_accept_seconds: validate_tcp_defer_accept_seconds(
                options.tcp_defer_accept_seconds,
            )?,
            socket_recv_buffer_size: validate_socket_buffer_size(
                "socketRecvBufferSize",
                options.socket_recv_buffer_size,
            )?,
            socket_send_buffer_size: validate_socket_buffer_size(
                "socketSendBufferSize",
                options.socket_send_buffer_size,
            )?,
            command_queue_capacity,
            event_queue_capacity,
            event_batch_size,
            send_queue_capacity,
            use_registered_send_buffer: options.use_registered_send_buffer.unwrap_or(false),
            use_recv_bundle,
            use_zero_copy_send: options.use_zero_copy_send.unwrap_or(false),
            send_buffer_count,
            send_buffer_size,
            use_zero_copy_receive,
            zcrx_interface_name: options.zcrx_interface_name,
            zcrx_rx_queue: validate_optional_u32("zcrxRxQueue", options.zcrx_rx_queue)?,
            zcrx_rx_buffer_size: validate_zcrx_rx_buffer_size(options.zcrx_rx_buffer_size)?,
        })
    }
}

fn validate_port(value: Option<f64>) -> Result<u16, UringError> {
    Ok(validate_u32_option("port", value, 0, 0, u16::MAX as u32)? as u16)
}

fn validate_queue_depth(value: Option<f64>) -> Result<u32, UringError> {
    Ok(validate_u32_option("queueDepth", value, DEFAULT_QUEUE_DEPTH, 1, u32::MAX)?.max(8))
}

fn validate_zcrx_rx_buffer_size(value: Option<f64>) -> Result<u32, UringError> {
    let size = match value {
        Some(raw) => validate_u32_value("zcrxRxBufferSize", raw, 0, u32::MAX)?,
        None => DEFAULT_ZCRX_RX_BUFFER_SIZE,
    };
    if size != 0 && size < 512 {
        return Err("zcrxRxBufferSize must be 0 or at least 512 bytes"
            .to_string()
            .into());
    }
    Ok(size)
}

fn validate_backlog(value: Option<f64>) -> Result<u32, UringError> {
    let backlog = match value {
        Some(raw) if valid_integer_in_range(raw, 1, libc::c_int::MAX as u32) => raw as u32,
        Some(_) => {
            return Err(format!("backlog must be between 1 and {}", libc::c_int::MAX).into());
        }
        None => DEFAULT_BACKLOG,
    };
    Ok(backlog)
}

fn validate_socket_buffer_size(name: &str, value: Option<f64>) -> Result<u32, UringError> {
    match value {
        Some(raw) if !raw.is_finite() || raw.fract() != 0.0 || raw < 0.0 => Err(format!(
            "{name} must be an integer between 0 and {}",
            libc::c_int::MAX
        )
        .into()),
        Some(raw) if raw > libc::c_int::MAX as f64 => {
            Err(format!("{name} must be <= {}", libc::c_int::MAX).into())
        }
        Some(raw) => Ok(raw as u32),
        None => Ok(0),
    }
}

fn validate_tcp_defer_accept_seconds(value: Option<f64>) -> Result<u32, UringError> {
    match value {
        Some(raw) if !raw.is_finite() || raw.fract() != 0.0 || raw < 0.0 => Err(format!(
            "tcpDeferAcceptSeconds must be an integer between 0 and {}",
            libc::c_int::MAX
        )
        .into()),
        Some(raw) if raw > libc::c_int::MAX as f64 => {
            Err(format!("tcpDeferAcceptSeconds must be <= {}", libc::c_int::MAX).into())
        }
        Some(raw) => Ok(raw as u32),
        None => Ok(0),
    }
}

fn validate_nonzero_u32_option(
    name: &str,
    value: Option<f64>,
    default: u32,
    zero_message: &str,
) -> Result<u32, UringError> {
    match value {
        Some(raw) if !raw.is_finite() || raw.fract() != 0.0 || raw < 0.0 => {
            Err(format!("{name} must be an integer between 1 and {}", u32::MAX).into())
        }
        Some(0.0) => Err(zero_message.to_string().into()),
        Some(raw) if raw > u32::MAX as f64 => {
            Err(format!("{name} must be an integer between 1 and {}", u32::MAX).into())
        }
        Some(raw) => Ok(raw as u32),
        None => Ok(default),
    }
}

fn validate_event_batch_size(value: f64, event_queue_capacity: u32) -> Result<u32, UringError> {
    if !valid_integer_in_range(value, 1, event_queue_capacity) {
        return Err(format!(
            "eventBatchSize must be between 1 and eventQueueCapacity ({event_queue_capacity})"
        )
        .into());
    }
    Ok(value as u32)
}

fn validate_event_queue_capacity(value: Option<f64>) -> Result<u32, UringError> {
    match value {
        Some(raw) if valid_integer_in_range(raw, 1, DEFAULT_EVENT_QUEUE_CAPACITY) => Ok(raw as u32),
        Some(_) => Err(format!(
            "eventQueueCapacity must be between 1 and {DEFAULT_EVENT_QUEUE_CAPACITY}"
        )
        .into()),
        None => Ok(DEFAULT_EVENT_QUEUE_CAPACITY),
    }
}

fn validate_u32_option(
    name: &str,
    value: Option<f64>,
    default: u32,
    min: u32,
    max: u32,
) -> Result<u32, UringError> {
    match value {
        Some(raw) => validate_u32_value(name, raw, min, max),
        None => Ok(default),
    }
}

fn validate_optional_u32(name: &str, value: Option<f64>) -> Result<Option<u32>, UringError> {
    value
        .map(|raw| validate_u32_value(name, raw, 0, u32::MAX))
        .transpose()
}

fn validate_u32_value(name: &str, value: f64, min: u32, max: u32) -> Result<u32, UringError> {
    if !valid_integer_in_range(value, min, max) {
        return Err(format!("{name} must be an integer between {min} and {max}").into());
    }
    Ok(value as u32)
}

fn valid_integer_in_range(value: f64, min: u32, max: u32) -> bool {
    value.is_finite() && value.fract() == 0.0 && value >= min as f64 && value <= max as f64
}

pub struct StartedServer {
    pub info: ServerInfo,
    pub stats: Arc<TransportStats>,
    pub shutdown: Arc<AtomicBool>,
    pub command_event_fd: RawFd,
    pub join: JoinHandle<()>,
}

pub struct StartedTcpServer {
    pub info: ServerInfo,
    pub stats: Arc<TransportStats>,
    pub shutdown: Arc<AtomicBool>,
    pub command_tx: mpsc::SyncSender<TcpCommand>,
    pub command_event_fd: RawFd,
    pub join: JoinHandle<()>,
}

#[derive(Default)]
pub(crate) struct ZcrxProbeConfig {
    pub interface_name: Option<String>,
    pub rx_queue: Option<u32>,
    pub rx_buffer_size: Option<u32>,
    pub active_registration: Option<bool>,
}

#[derive(Default)]
pub struct TransportStats {
    accepted_connections: AtomicU64,
    rejected_connections: AtomicU64,
    idle_timeouts: AtomicU64,
    closed_connections: AtomicU64,
    active_connections: AtomicU64,
    bytes_received: AtomicU64,
    bytes_sent: AtomicU64,
    recv_bundle_completions: AtomicU64,
    recv_bundle_buffers: AtomicU64,
    recv_bundle_bytes: AtomicU64,
    recv_buffer_starvations: AtomicU64,
    recv_multishot_resubmits: AtomicU64,
    recv_copy_events: AtomicU64,
    recv_copy_bytes: AtomicU64,
    registered_send_requests: AtomicU64,
    registered_send_errors: AtomicU64,
    fixed_send_buffer_misses: AtomicU64,
    fixed_send_buffer_miss_bytes: AtomicU64,
    command_queue_drops: AtomicU64,
    event_queue_inflight: AtomicU64,
    event_queue_drops: AtomicU64,
    send_queue_drops: AtomicU64,
    zero_copy_send_requests: AtomicU64,
    zero_copy_send_notifications: AtomicU64,
    zero_copy_send_copied: AtomicU64,
    zero_copy_send_errors: AtomicU64,
    zcrx_packets: AtomicU64,
    zcrx_bytes: AtomicU64,
}

impl TransportStats {
    pub(crate) fn apply_to_info(&self, info: &mut ServerInfo) {
        info.accepted_connections = js_counter(self.accepted_connections.load(Ordering::Relaxed));
        info.rejected_connections = js_counter(self.rejected_connections.load(Ordering::Relaxed));
        info.idle_timeouts = js_counter(self.idle_timeouts.load(Ordering::Relaxed));
        info.closed_connections = js_counter(self.closed_connections.load(Ordering::Relaxed));
        info.active_connections = js_counter(self.active_connections.load(Ordering::Relaxed));
        info.bytes_received = js_counter(self.bytes_received.load(Ordering::Relaxed));
        info.bytes_sent = js_counter(self.bytes_sent.load(Ordering::Relaxed));
        info.recv_bundle_completions =
            js_counter(self.recv_bundle_completions.load(Ordering::Relaxed));
        info.recv_bundle_buffers = js_counter(self.recv_bundle_buffers.load(Ordering::Relaxed));
        info.recv_bundle_bytes = js_counter(self.recv_bundle_bytes.load(Ordering::Relaxed));
        info.recv_buffer_starvations =
            js_counter(self.recv_buffer_starvations.load(Ordering::Relaxed));
        info.recv_multishot_resubmits =
            js_counter(self.recv_multishot_resubmits.load(Ordering::Relaxed));
        info.recv_copy_events = js_counter(self.recv_copy_events.load(Ordering::Relaxed));
        info.recv_copy_bytes = js_counter(self.recv_copy_bytes.load(Ordering::Relaxed));
        info.registered_send_requests =
            js_counter(self.registered_send_requests.load(Ordering::Relaxed));
        info.registered_send_errors =
            js_counter(self.registered_send_errors.load(Ordering::Relaxed));
        info.fixed_send_buffer_misses =
            js_counter(self.fixed_send_buffer_misses.load(Ordering::Relaxed));
        info.fixed_send_buffer_miss_bytes =
            js_counter(self.fixed_send_buffer_miss_bytes.load(Ordering::Relaxed));
        info.command_queue_drops = js_counter(self.command_queue_drops.load(Ordering::Relaxed));
        info.event_queue_drops = js_counter(self.event_queue_drops.load(Ordering::Relaxed));
        info.send_queue_drops = js_counter(self.send_queue_drops.load(Ordering::Relaxed));
        info.zero_copy_send_requests =
            js_counter(self.zero_copy_send_requests.load(Ordering::Relaxed));
        info.zero_copy_send_notifications =
            js_counter(self.zero_copy_send_notifications.load(Ordering::Relaxed));
        info.zero_copy_send_copied = js_counter(self.zero_copy_send_copied.load(Ordering::Relaxed));
        info.zero_copy_send_errors = js_counter(self.zero_copy_send_errors.load(Ordering::Relaxed));
        info.zcrx_packets = js_counter(self.zcrx_packets.load(Ordering::Relaxed));
        info.zcrx_bytes = js_counter(self.zcrx_bytes.load(Ordering::Relaxed));
    }

    fn record_zero_copy_send_request(&self) {
        self.zero_copy_send_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn record_connection_open(&self) {
        self.accepted_connections.fetch_add(1, Ordering::Relaxed);
        self.active_connections.fetch_add(1, Ordering::Relaxed);
    }

    fn record_connection_reject(&self) {
        self.rejected_connections.fetch_add(1, Ordering::Relaxed);
    }

    fn record_idle_timeout(&self) {
        self.idle_timeouts.fetch_add(1, Ordering::Relaxed);
    }

    fn record_connection_close(&self) {
        self.closed_connections.fetch_add(1, Ordering::Relaxed);
        let _ =
            self.active_connections
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                    active.checked_sub(1)
                });
    }

    fn record_bytes_received(&self, bytes: usize) {
        self.bytes_received
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_bytes_sent(&self, bytes: usize) {
        self.bytes_sent.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_zero_copy_send_notification(&self, result: i32) {
        self.zero_copy_send_notifications
            .fetch_add(1, Ordering::Relaxed);
        if (result as u32) & NOTIF_USAGE_ZC_COPIED != 0 {
            self.zero_copy_send_copied.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_zero_copy_send_error(&self) {
        self.zero_copy_send_errors.fetch_add(1, Ordering::Relaxed);
    }

    fn record_zcrx_packet(&self, bytes: usize) {
        self.zcrx_packets.fetch_add(1, Ordering::Relaxed);
        self.zcrx_bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_recv_bundle(&self, buffers: usize, bytes: usize) {
        self.recv_bundle_completions.fetch_add(1, Ordering::Relaxed);
        self.recv_bundle_buffers
            .fetch_add(buffers as u64, Ordering::Relaxed);
        self.recv_bundle_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_recv_buffer_starvation(&self) {
        self.recv_buffer_starvations.fetch_add(1, Ordering::Relaxed);
    }

    fn record_recv_multishot_resubmit(&self) {
        self.recv_multishot_resubmits
            .fetch_add(1, Ordering::Relaxed);
    }

    fn record_recv_copy(&self, bytes: usize) {
        self.recv_copy_events.fetch_add(1, Ordering::Relaxed);
        self.recv_copy_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_registered_send_request(&self) {
        self.registered_send_requests
            .fetch_add(1, Ordering::Relaxed);
    }

    fn record_registered_send_error(&self) {
        self.registered_send_errors.fetch_add(1, Ordering::Relaxed);
    }

    fn record_fixed_send_buffer_miss(&self, bytes: usize) {
        self.fixed_send_buffer_misses
            .fetch_add(1, Ordering::Relaxed);
        self.fixed_send_buffer_miss_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    fn record_send_queue_drop(&self) {
        self.send_queue_drops.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_command_queue_drop(&self) {
        self.command_queue_drops.fetch_add(1, Ordering::Relaxed);
    }

    fn try_acquire_event_queue_slots(&self, count: usize, capacity: u32) -> bool {
        if count == 0 {
            return true;
        }
        let count = count as u64;
        let capacity = capacity as u64;
        let mut current = self.event_queue_inflight.load(Ordering::Acquire);
        loop {
            let Some(next) = current.checked_add(count) else {
                return false;
            };
            if next > capacity {
                return false;
            }
            match self.event_queue_inflight.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    fn release_event_queue_slots(&self, count: usize) {
        if count > 0 {
            self.event_queue_inflight
                .fetch_sub(count as u64, Ordering::AcqRel);
        }
    }

    fn record_event_queue_drop(&self, count: usize) {
        if count > 0 {
            self.event_queue_drops
                .fetch_add(count as u64, Ordering::Relaxed);
        }
    }
}

fn js_counter(value: u64) -> f64 {
    value.min(MAX_SAFE_JS_INTEGER) as f64
}

pub(crate) struct TcpSendCommand {
    pub connection_id: u32,
    pub data: Vec<u8>,
}

pub(crate) enum TcpCommand {
    Send { connection_id: u32, data: Vec<u8> },
    SendBatch { sends: Vec<TcpSendCommand> },
    SendAndClose { connection_id: u32, data: Vec<u8> },
    SendBatchAndClose { sends: Vec<TcpSendCommand> },
    Close { connection_id: u32 },
}

struct WorkerReady {
    provided_buffer_ring: bool,
    recv_bundle: bool,
    registered_send_buffer: bool,
    zero_copy_send: bool,
    zcrx_ready: bool,
    zcrx_rx_buffer_size: u32,
}

struct TcpWorkerRuntime {
    shutdown: Arc<AtomicBool>,
    ready_tx: Option<mpsc::Sender<Result<WorkerReady, String>>>,
    command_rx: Receiver<TcpCommand>,
    event_sink: TcpEventSink,
    stats: Arc<TransportStats>,
}

struct Connection {
    id: u32,
    send_offset: usize,
    send_started: bool,
    zero_copy_disabled: bool,
    registered_send_disabled: bool,
    recv_active: bool,
    last_activity: Instant,
}

struct RecvContext<'a> {
    buffers: &'a mut BufferPool,
    connections: &'a mut HashMap<RawFd, Connection>,
    id_to_fd: &'a mut HashMap<u32, RawFd>,
    response: &'a Arc<[u8]>,
    stats: &'a TransportStats,
    use_recv_bundle: bool,
    use_zero_copy_send: bool,
    registered_send_buffer: bool,
    buffer_size: u32,
}

struct ZcrxRecvContext<'a> {
    zcrx: &'a mut ZcrxRegistration,
    connections: &'a mut HashMap<RawFd, Connection>,
    id_to_fd: &'a mut HashMap<u32, RawFd>,
    response: &'a Arc<[u8]>,
    stats: &'a TransportStats,
    use_zero_copy_send: bool,
    registered_send_buffer: bool,
    buffer_size: u32,
}

struct AcceptContext<'a> {
    connections: &'a mut HashMap<RawFd, Connection>,
    id_to_fd: &'a mut HashMap<u32, RawFd>,
    next_connection_id: &'a mut u32,
    buffer_size: u32,
    use_recv_bundle: bool,
    max_connections: u32,
    tcp_no_delay: bool,
    socket_recv_buffer_size: u32,
    socket_send_buffer_size: u32,
    stats: &'a TransportStats,
}

struct SendContext<'a> {
    connections: &'a mut HashMap<RawFd, Connection>,
    id_to_fd: &'a mut HashMap<u32, RawFd>,
    response: &'a Arc<[u8]>,
    stats: &'a TransportStats,
    use_zero_copy_send: bool,
    registered_send_buffer: bool,
}

struct HttpSendOptions {
    offset: usize,
    use_zero_copy_send: bool,
    registered_send_buffer: bool,
}

#[derive(Default)]
struct HttpRequestProbe {
    bytes: usize,
    prefix: [u8; 5],
    prefix_len: usize,
    header_end_match: usize,
    saw_header_end: bool,
}

impl HttpRequestProbe {
    fn observe(&mut self, chunk: &[u8]) {
        const HEADER_END: &[u8; 4] = b"\r\n\r\n";

        for &byte in chunk {
            if self.prefix_len < self.prefix.len() {
                self.prefix[self.prefix_len] = byte;
                self.prefix_len += 1;
            }

            if byte == HEADER_END[self.header_end_match] {
                self.header_end_match += 1;
                if self.header_end_match == HEADER_END.len() {
                    self.saw_header_end = true;
                    self.header_end_match = 0;
                }
            } else {
                self.header_end_match = usize::from(byte == HEADER_END[0]);
            }
        }
        self.bytes += chunk.len();
    }

    fn should_respond(&self) -> bool {
        self.saw_header_end
            || (self.prefix_len >= 4 && &self.prefix[..4] == b"GET ")
            || (self.prefix_len >= 5 && &self.prefix[..5] == b"POST ")
    }
}

struct TcpConnection {
    id: u32,
    recv_active: bool,
    close_after_send: bool,
    data_event_pending: bool,
    half_close_grace_ticks: u8,
    send_queue: VecDeque<TcpPendingSend>,
    active_send: Option<TcpPendingSend>,
    last_activity: Instant,
}

struct TcpPendingSend {
    data: TcpSendData,
    offset: usize,
    use_zero_copy: bool,
    waiting_notification: bool,
    notification_result: i32,
}

enum TcpSendData {
    Heap(Arc<[u8]>),
    Fixed { slot: u16, len: usize },
}

impl TcpPendingSend {
    fn len(&self) -> usize {
        match &self.data {
            TcpSendData::Heap(data) => data.len(),
            TcpSendData::Fixed { len, .. } => *len,
        }
    }

    fn slot(&self) -> Option<u16> {
        match self.data {
            TcpSendData::Heap(_) => None,
            TcpSendData::Fixed { slot, .. } => Some(slot),
        }
    }
}

struct TcpWorkerState {
    connections: HashMap<RawFd, TcpConnection>,
    id_to_fd: HashMap<u32, RawFd>,
    next_connection_id: u32,
}

struct TcpRecvContext<'a> {
    buffers: &'a mut BufferPool,
    state: &'a mut TcpWorkerState,
    event_emitter: &'a mut TcpEventEmitter,
    fixed_send_pool: Option<&'a mut FixedSendBufferPool>,
    buffer_size: u32,
    stats: &'a TransportStats,
    use_recv_bundle: bool,
}

struct TcpZcrxRecvContext<'a> {
    zcrx: &'a mut ZcrxRegistration,
    state: &'a mut TcpWorkerState,
    event_emitter: &'a mut TcpEventEmitter,
    fixed_send_pool: Option<&'a mut FixedSendBufferPool>,
    buffer_size: u32,
    stats: &'a TransportStats,
}

struct TcpZcrxAcceptContext<'a> {
    state: &'a mut TcpWorkerState,
    event_emitter: &'a mut TcpEventEmitter,
    zcrx_id: u32,
    buffer_size: u32,
    max_connections: u32,
    tcp_no_delay: bool,
    socket_recv_buffer_size: u32,
    socket_send_buffer_size: u32,
    stats: &'a TransportStats,
}

struct TcpAcceptContext<'a> {
    state: &'a mut TcpWorkerState,
    event_emitter: &'a mut TcpEventEmitter,
    buffer_size: u32,
    use_recv_bundle: bool,
    max_connections: u32,
    tcp_no_delay: bool,
    socket_recv_buffer_size: u32,
    socket_send_buffer_size: u32,
    stats: &'a TransportStats,
}

struct TcpSendContext<'a> {
    state: &'a mut TcpWorkerState,
    event_emitter: &'a mut TcpEventEmitter,
    fixed_send_pool: Option<&'a mut FixedSendBufferPool>,
    stats: &'a TransportStats,
}

#[derive(Clone, Copy)]
struct TcpSendOptions {
    use_registered_send_buffer: bool,
    use_zero_copy_send: bool,
}

struct TcpQueueSendContext<'a> {
    fixed_send_pool: Option<&'a mut FixedSendBufferPool>,
    send_options: TcpSendOptions,
    send_queue_capacity: u32,
    stats: &'a TransportStats,
}

struct TcpEchoRecvContext<'a> {
    buffers: &'a mut BufferPool,
    state: &'a mut TcpWorkerState,
    event_emitter: &'a mut TcpEventEmitter,
    fixed_send_pool: Option<&'a mut FixedSendBufferPool>,
    buffer_size: u32,
    send_queue_capacity: u32,
    stats: &'a TransportStats,
    use_recv_bundle: bool,
    use_registered_send_buffer: bool,
    use_zero_copy_send: bool,
}

struct TcpZcrxEchoRecvContext<'a> {
    zcrx: &'a mut ZcrxRegistration,
    state: &'a mut TcpWorkerState,
    event_emitter: &'a mut TcpEventEmitter,
    fixed_send_pool: Option<&'a mut FixedSendBufferPool>,
    buffer_size: u32,
    send_queue_capacity: u32,
    stats: &'a TransportStats,
    use_registered_send_buffer: bool,
    use_zero_copy_send: bool,
}

struct TcpEventEmitter {
    sink: TcpEventSink,
    batch: Vec<TcpEvent>,
    stats: Arc<TransportStats>,
    event_queue_capacity: u32,
    event_batch_size: usize,
}

impl TcpEventEmitter {
    fn new(
        sink: TcpEventSink,
        stats: Arc<TransportStats>,
        event_queue_capacity: u32,
        event_batch_size: u32,
    ) -> Self {
        let event_batch_size = event_batch_size as usize;
        Self {
            sink,
            batch: Vec::with_capacity(event_batch_size),
            stats,
            event_queue_capacity,
            event_batch_size,
        }
    }

    fn none() -> Self {
        Self::new(
            TcpEventSink::None,
            Arc::new(TransportStats::default()),
            0,
            DEFAULT_EVENT_BATCH_SIZE,
        )
    }

    fn emit(&mut self, event: TcpEvent) -> Result<(), UringError> {
        match &self.sink {
            TcpEventSink::None => Ok(()),
            TcpEventSink::Single(callback) => emit_tcp_event(
                callback,
                event,
                Arc::clone(&self.stats),
                self.event_queue_capacity,
            ),
            TcpEventSink::Batch(_) => {
                self.batch.push(event);
                if self.batch.len() >= self.event_batch_size {
                    self.flush()?;
                }
                Ok(())
            }
        }
    }

    fn flush(&mut self) -> Result<(), UringError> {
        if self.batch.is_empty() {
            return Ok(());
        }
        let TcpEventSink::Batch(callback) = &self.sink else {
            self.batch.clear();
            return Ok(());
        };
        let events = std::mem::take(&mut self.batch);
        let event_count = events.len();
        if !self
            .stats
            .try_acquire_event_queue_slots(event_count, self.event_queue_capacity)
        {
            self.stats.record_event_queue_drop(event_count);
            return Ok(());
        }
        let stats = Arc::clone(&self.stats);
        match callback.call_with_return_value(
            events,
            ThreadsafeFunctionCallMode::NonBlocking,
            move |_, _| {
                stats.release_event_queue_slots(event_count);
                Ok(())
            },
        ) {
            Status::Ok => Ok(()),
            Status::Closing => {
                self.stats.release_event_queue_slots(event_count);
                Ok(())
            }
            Status::QueueFull => {
                self.stats.release_event_queue_slots(event_count);
                self.stats.record_event_queue_drop(event_count);
                Ok(())
            }
            status => Err(format!("TCP event callback failed: {status}").into()),
        }
    }
}

struct FixedSendBufferPool {
    buffers: Vec<u8>,
    slot_size: usize,
    free: VecDeque<u16>,
}

impl FixedSendBufferPool {
    fn setup<C: cqueue::EntryMarker>(
        ring: &Ring<C>,
        slots: u16,
        slot_size: usize,
    ) -> Result<Self, UringError> {
        let mut buffers = vec![0; slots as usize * slot_size];
        let base = buffers.as_mut_ptr();
        let iovecs = (0..slots)
            .map(|slot| libc::iovec {
                // SAFETY: slot is within 0..slots and buffers was allocated to
                // hold slots * slot_size bytes, so each slot base is in-bounds.
                iov_base: unsafe { base.add(slot as usize * slot_size) }.cast::<libc::c_void>(),
                iov_len: slot_size,
            })
            .collect::<Vec<_>>();
        // SAFETY: iovecs point into `buffers`, which is moved into the returned
        // pool and kept alive until buffers are unregistered/dropped with the ring.
        unsafe {
            ring.submitter().register_buffers(&iovecs)?;
        }
        Ok(Self {
            buffers,
            slot_size,
            free: (0..slots).collect(),
        })
    }

    fn alloc(&mut self, data: &[u8]) -> Option<u16> {
        if data.len() > self.slot_size {
            return None;
        }
        let slot = self.free.pop_front()?;
        let start = slot as usize * self.slot_size;
        let end = start + data.len();
        self.buffers[start..end].copy_from_slice(data);
        Some(slot)
    }

    fn release(&mut self, slot: u16) {
        self.free.push_back(slot);
    }

    fn copy_slot(&self, slot: u16, len: usize) -> Arc<[u8]> {
        let start = slot as usize * self.slot_size;
        let end = start + len.min(self.slot_size);
        Arc::<[u8]>::from(&self.buffers[start..end])
    }

    fn ptr(&self, slot: u16, offset: usize) -> *const u8 {
        // SAFETY: callers only request slots allocated by this pool and offsets
        // below the pending send length, which is bounded by slot_size.
        unsafe {
            self.buffers
                .as_ptr()
                .add(slot as usize * self.slot_size + offset)
        }
    }
}

impl Default for TcpWorkerState {
    fn default() -> Self {
        Self {
            connections: HashMap::new(),
            id_to_fd: HashMap::new(),
            next_connection_id: 1,
        }
    }
}

struct ProvidedBufferRing {
    entries: NonNull<types::BufRingEntry>,
    mmap_len: usize,
    entries_count: u16,
    buffer_size: usize,
    buffers: Vec<u8>,
    head: u16,
    tail: u16,
}

// SAFETY: ProvidedBufferRing is owned by one worker thread after construction.
// The raw mapped ring pointer and backing buffer are only touched through
// &mut self methods on that owner, and Drop runs after the worker has stopped
// submitting ring entries that reference it.
unsafe impl Send for ProvidedBufferRing {}

impl ProvidedBufferRing {
    fn new(entries_count: u16, buffer_size: usize) -> Result<Self, UringError> {
        let size = entries_count as usize * std::mem::size_of::<types::BufRingEntry>();
        // SAFETY: mmap is called for an anonymous private mapping sized exactly
        // for the requested buf-ring entries and checked against MAP_FAILED.
        let raw = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
                -1,
                0,
            )
        };
        if raw == libc::MAP_FAILED {
            return Err(io::Error::last_os_error().into());
        }
        let entries = NonNull::new(raw.cast::<types::BufRingEntry>())
            .ok_or_else(|| UringError("mmap returned a null buffer ring".to_string()))?;

        Ok(Self {
            entries,
            mmap_len: size,
            entries_count,
            buffer_size,
            buffers: vec![0; entries_count as usize * buffer_size],
            head: 0,
            tail: 0,
        })
    }

    fn register<C: cqueue::EntryMarker>(&mut self, ring: &Ring<C>) -> Result<(), UringError> {
        // SAFETY: entries points to a live mmap of entries_count BufRingEntry
        // values and remains owned by self for at least the registered lifetime.
        unsafe {
            ring.submitter().register_buf_ring_with_flags(
                self.entries.as_ptr() as u64,
                self.entries_count,
                BGID,
                0,
            )?;
        }
        self.tail = 0;
        self.head = 0;
        // SAFETY: io-uring defines the tail word inside the registered
        // BufRingEntry mapping; entries points to that live mapping.
        let tail = unsafe { types::BufRingEntry::tail(self.entries.as_ptr()) as *mut u16 };
        // SAFETY: tail is the kernel-defined tail location for this buf ring
        // and is initialized before any entries are published.
        unsafe {
            tail.write(0);
        }
        for bid in 0..self.entries_count {
            self.add(bid);
        }
        self.publish_tail();
        Ok(())
    }

    fn unregister<C: cqueue::EntryMarker>(&self, ring: &Ring<C>) {
        let _ = ring.submitter().unregister_buf_ring(BGID);
    }

    fn add(&mut self, bid: u16) {
        let idx = self.tail & (self.entries_count - 1);
        let offset = bid as usize * self.buffer_size;
        // SAFETY: idx is masked into the entries_count ring, entries points to
        // the live mapping, and &mut self guarantees exclusive writer access.
        let entry = unsafe { &mut *self.entries.as_ptr().add(idx as usize) };
        // SAFETY: bid is drawn from the configured buffer ids, so offset points
        // at the start of a buffer_size slot inside self.buffers.
        entry.set_addr(unsafe { self.buffers.as_mut_ptr().add(offset) } as u64);
        entry.set_len(self.buffer_size as u32);
        entry.set_bid(bid);
        self.tail = self.tail.wrapping_add(1);
    }

    fn recycle(&mut self, bid: u16) {
        self.add(bid);
        self.publish_tail();
    }

    fn consume_bundle(
        &mut self,
        first_bid: u16,
        len: usize,
    ) -> Result<Vec<ReceivedBuffer>, UringError> {
        let mut remaining = len;
        let mut head = self.head;
        let mut buffers = Vec::new();
        while remaining > 0 {
            // SAFETY: head is advanced modulo entries_count and entries points
            // to the live registered buf-ring mapping.
            let entry = unsafe {
                &*self
                    .entries
                    .as_ptr()
                    .add((head & (self.entries_count - 1)) as usize)
            };
            let bid = entry.bid();
            if buffers.is_empty() && bid != first_bid {
                return Err(format!(
                    "recv bundle buffer head mismatch: cqe bid {first_bid}, ring bid {bid}"
                )
                .into());
            }
            let chunk_len = remaining.min(entry.len() as usize).min(self.buffer_size);
            buffers.push(ReceivedBuffer {
                bid,
                len: chunk_len,
            });
            remaining -= chunk_len;
            head = head.wrapping_add(1);
        }
        self.head = head;
        Ok(buffers)
    }

    fn publish_tail(&self) {
        fence(Ordering::Release);
        // SAFETY: io-uring defines the tail word inside the registered
        // BufRingEntry mapping; entries points to that live mapping.
        let tail = unsafe { types::BufRingEntry::tail(self.entries.as_ptr()) as *mut u16 };
        // SAFETY: the release fence above makes entry writes visible before the
        // tail update observed by the kernel.
        unsafe {
            tail.write_volatile(self.tail);
        }
    }

    fn read(&self, bid: u16, len: usize) -> &[u8] {
        let offset = bid as usize * self.buffer_size;
        &self.buffers[offset..offset + len.min(self.buffer_size)]
    }
}

struct ReceivedBuffer {
    bid: u16,
    len: usize,
}

impl Drop for ProvidedBufferRing {
    fn drop(&mut self) {
        // SAFETY: entries/mmap_len came from a successful mmap in new() and the
        // ProvidedBufferRing owns that mapping.
        unsafe {
            libc::munmap(self.entries.as_ptr().cast(), self.mmap_len);
        }
    }
}

struct LegacyProvidedBuffers {
    entries_count: u16,
    buffer_size: usize,
    buffers: Vec<u8>,
}

impl LegacyProvidedBuffers {
    fn new(entries_count: u16, buffer_size: usize) -> Self {
        Self {
            entries_count,
            buffer_size,
            buffers: vec![0; entries_count as usize * buffer_size],
        }
    }

    fn provide_all<C: cqueue::EntryMarker>(
        &mut self,
        ring: &mut Ring<C>,
    ) -> Result<(), UringError> {
        let entry = opcode::ProvideBuffers::new(
            self.buffers.as_mut_ptr(),
            self.buffer_size as i32,
            self.entries_count,
            BGID,
            0,
        )
        .build()
        .user_data(pack_user_data(OP_PROVIDE, 0));
        push_entry(ring, entry)?;
        ring.submit_and_wait(1)?;

        let completions: Vec<_> = ring
            .completion()
            .map(|cqe| {
                let cqe: cqueue::Entry = cqe.into();
                (cqe.user_data(), cqe.result())
            })
            .collect();
        for (user_data, result) in completions {
            if unpack_user_data(user_data).0 == OP_PROVIDE && result < 0 {
                return Err(io::Error::from_raw_os_error(-result).into());
            }
        }
        Ok(())
    }

    fn recycle<C: cqueue::EntryMarker>(
        &mut self,
        ring: &mut Ring<C>,
        bid: u16,
    ) -> Result<(), UringError> {
        let offset = bid as usize * self.buffer_size;
        let entry = opcode::ProvideBuffers::new(
            // SAFETY: bid is provided by the kernel for this buffer group and
            // indexes a buffer_size slot in the backing buffers vector.
            unsafe { self.buffers.as_mut_ptr().add(offset) },
            self.buffer_size as i32,
            1,
            BGID,
            bid,
        )
        .build()
        .user_data(pack_user_data(OP_PROVIDE, 0));
        push_entry(ring, entry)
    }

    fn read(&self, bid: u16, len: usize) -> &[u8] {
        let offset = bid as usize * self.buffer_size;
        &self.buffers[offset..offset + len.min(self.buffer_size)]
    }
}

enum BufferPool {
    Ring(ProvidedBufferRing),
    Legacy(LegacyProvidedBuffers),
}

impl BufferPool {
    fn setup<C: cqueue::EntryMarker>(
        ring: &mut Ring<C>,
        entries_count: u16,
        buffer_size: usize,
    ) -> Result<Self, UringError> {
        let mut buf_ring = ProvidedBufferRing::new(entries_count, buffer_size)?;
        match buf_ring.register(ring) {
            Ok(()) => Ok(Self::Ring(buf_ring)),
            Err(ring_error) => {
                let mut legacy = LegacyProvidedBuffers::new(entries_count, buffer_size);
                match legacy.provide_all(ring) {
                    Ok(()) => Ok(Self::Legacy(legacy)),
                    Err(legacy_error) => Err(format!(
                        "provided-buffer ring failed ({ring_error}); legacy provided buffers failed ({legacy_error})"
                    )
                    .into()),
                }
            }
        }
    }

    fn provided_buffer_ring(&self) -> bool {
        matches!(self, Self::Ring(_))
    }

    fn consume_recv<C: cqueue::EntryMarker>(
        &mut self,
        ring: &mut Ring<C>,
        bid: u16,
        len: usize,
        use_recv_bundle: bool,
        stats: &TransportStats,
    ) -> Result<Vec<u8>, UringError> {
        let mut data = Vec::with_capacity(len);
        self.visit_recv(ring, bid, len, use_recv_bundle, stats, |chunk| {
            data.extend_from_slice(chunk);
        })?;
        stats.record_recv_copy(data.len());
        Ok(data)
    }

    fn discard_recv<C: cqueue::EntryMarker>(
        &mut self,
        ring: &mut Ring<C>,
        bid: u16,
        len: usize,
        use_recv_bundle: bool,
        stats: &TransportStats,
    ) -> Result<(), UringError> {
        self.visit_recv(ring, bid, len, use_recv_bundle, stats, |_| ())
    }

    fn visit_recv<C, F>(
        &mut self,
        ring: &mut Ring<C>,
        bid: u16,
        len: usize,
        use_recv_bundle: bool,
        stats: &TransportStats,
        mut visitor: F,
    ) -> Result<(), UringError>
    where
        C: cqueue::EntryMarker,
        F: FnMut(&[u8]),
    {
        match self {
            Self::Ring(pool) if use_recv_bundle => {
                let buffers = pool.consume_bundle(bid, len)?;
                let mut total_len = 0;
                for buffer in &buffers {
                    let chunk = pool.read(buffer.bid, buffer.len);
                    total_len += chunk.len();
                    visitor(chunk);
                }
                let buffer_count = buffers.len();
                for buffer in buffers {
                    pool.recycle(buffer.bid);
                }
                stats.record_recv_bundle(buffer_count, total_len);
                Ok(())
            }
            Self::Ring(pool) => {
                visitor(pool.read(bid, len));
                pool.recycle(bid);
                Ok(())
            }
            Self::Legacy(pool) => {
                visitor(pool.read(bid, len));
                pool.recycle(ring, bid)
            }
        }
    }

    fn unregister<C: cqueue::EntryMarker>(&self, ring: &Ring<C>) {
        if let Self::Ring(pool) = self {
            pool.unregister(ring);
        }
    }
}

pub fn capabilities() -> Capabilities {
    match probe_capabilities() {
        Ok(caps) => caps,
        Err(error) => Capabilities {
            platform: std::env::consts::OS.to_string(),
            kernel_release: kernel_release(),
            io_uring_available: false,
            accept: false,
            accept_multi: false,
            recv: false,
            recv_multi: false,
            provided_buffers: false,
            provided_buffer_ring: false,
            provided_buffer_ring_probe: "io_uring probe unavailable".to_string(),
            recv_bundle: false,
            send: false,
            send_zc: false,
            registered_send_buffer: false,
            registered_send_buffer_probe: "io_uring probe unavailable".to_string(),
            recv_zc: false,
            zcrx_kernel_opcode: false,
            zcrx_cqe32_ring: false,
            zcrx_cqe32_ring_probe: "io_uring probe unavailable".to_string(),
            zcrx_kernel_security_warnings: zcrx_kernel_security_warnings(),
            fast_poll: false,
            note: error.to_string(),
        },
    }
}

pub fn zcrx_probe(options: ZcrxProbeConfig) -> ZcrxProbe {
    let kernel_opcode = probe_capabilities()
        .map(|caps| caps.zcrx_kernel_opcode)
        .unwrap_or(false);
    let requested_interface = options.interface_name;
    let rx_queue = options.rx_queue.unwrap_or(0);
    let rx_buffer_size = options
        .rx_buffer_size
        .unwrap_or(DEFAULT_ZCRX_RX_BUFFER_SIZE);
    let active_registration = options.active_registration.unwrap_or(false);
    let interface_name = requested_interface.or_else(default_zcrx_interface);
    let interface_path = interface_name
        .as_ref()
        .map(|name| PathBuf::from("/sys/class/net").join(name));
    let interface_exists = interface_path
        .as_ref()
        .map(|path| path.exists())
        .unwrap_or(false);
    let operstate = interface_path
        .as_ref()
        .and_then(|path| read_trimmed(path.join("operstate")));
    let rx_queue_count = interface_path
        .as_ref()
        .map(|path| count_rx_queues(&path.join("queues")))
        .unwrap_or(0);
    let driver = interface_path.as_ref().and_then(|path| read_driver(path));
    let is_loopback = interface_name.as_deref() == Some("lo");
    let is_virtual = interface_path
        .as_ref()
        .map(|path| !path.join("device").exists())
        .unwrap_or(false);
    let interface_index = interface_name
        .as_ref()
        .and_then(|name| interface_index(name))
        .unwrap_or(0);
    let ethtool_available = Command::new("ethtool")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    let features = if ethtool_available {
        interface_name
            .as_ref()
            .and_then(|name| ethtool_output(&["-k", name]))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let header_data_split = feature_state(&features, &["tcp-data-split", "header-data-split"])
        .unwrap_or_else(|| "unknown".to_string());
    let flow_steering = feature_state(&features, &["ntuple-filters", "rx-ntuple-filter"])
        .unwrap_or_else(|| "unknown".to_string());

    let mut blockers = Vec::new();
    if !kernel_opcode {
        blockers.push("kernel does not expose IORING_OP_RECV_ZC".to_string());
    }
    if interface_name.is_none() {
        blockers.push("no network interface selected or discovered".to_string());
    }
    if !interface_exists {
        blockers.push("network interface does not exist in /sys/class/net".to_string());
    }
    if is_loopback {
        blockers.push("loopback is not a ZCRX-capable NIC".to_string());
    }
    if is_virtual {
        blockers.push(
            "interface appears virtual; ZCRX requires a capable physical NIC queue".to_string(),
        );
    }
    if rx_queue_count == 0 {
        blockers.push("no RX queues found for interface".to_string());
    }
    if rx_queue_count > 0 && rx_queue >= rx_queue_count {
        blockers.push(format!(
            "RX queue {rx_queue} is outside discovered queue count {rx_queue_count}"
        ));
    }
    if rx_buffer_size != 0 && rx_buffer_size < 512 {
        blockers.push("rxBufferSize must be 0 or at least 512 bytes".to_string());
    }
    if header_data_split != "on" {
        blockers.push(format!(
            "NIC header/data split is not proven enabled ({header_data_split})"
        ));
    }
    if flow_steering != "on" {
        blockers.push(format!(
            "flow steering/ntuple support is not proven enabled ({flow_steering})"
        ));
    }
    let kernel_security_warnings = zcrx_kernel_security_warnings();
    if !kernel_security_warnings.is_empty() && !zcrx_kernel_security_override_enabled() {
        blockers.extend(
            kernel_security_warnings
                .iter()
                .map(|warning| zcrx_kernel_security_blocker_message(warning)),
        );
    }

    let mut active_registration_result = None;
    let mut active_registration_errno = None;
    if active_registration {
        let active_result = if !kernel_opcode {
            ZcrxActiveProbeResult {
                message: "active ZCRX registration probe was not run: kernel does not expose IORING_OP_RECV_ZC"
                    .to_string(),
                errno: None,
                success: false,
            }
        } else if interface_index == 0 {
            ZcrxActiveProbeResult {
                message: "active ZCRX registration probe was not run: network interface index is unavailable"
                    .to_string(),
                errno: None,
                success: false,
            }
        } else if rx_queue_count > 0 && rx_queue >= rx_queue_count {
            ZcrxActiveProbeResult {
                message: format!(
                    "active ZCRX registration probe was not run: RX queue {rx_queue} is outside discovered queue count {rx_queue_count}"
                ),
                errno: None,
                success: false,
            }
        } else if rx_buffer_size != 0 && rx_buffer_size < 512 {
            ZcrxActiveProbeResult {
                message:
                    "active ZCRX registration probe was not run: rxBufferSize must be 0 or at least 512 bytes"
                        .to_string(),
                errno: None,
                success: false,
            }
        } else {
            active_zcrx_registration_probe(interface_index, rx_queue, rx_buffer_size)
        };

        if !active_result.success {
            blockers.push(active_result.message.clone());
        }
        active_registration_errno = active_result.errno;
        active_registration_result = Some(active_result.message);
    }

    let ready = blockers.is_empty();
    ZcrxProbe {
        interface_name,
        interface_index,
        kernel_opcode,
        interface_exists,
        operstate,
        rx_queue,
        rx_buffer_size,
        rx_queue_count,
        driver,
        is_loopback,
        is_virtual,
        ethtool_available,
        header_data_split,
        flow_steering,
        active_registration,
        active_registration_result,
        active_registration_errno,
        kernel_security_warnings,
        ready,
        blockers,
        note: "ZCRX readiness also requires io_uring ifq and memory-region registration at server startup. By default this probe is passive; pass activeRegistration: true to attempt a short-lived ifq registration on the selected queue."
            .to_string(),
    }
}

fn ensure_zcrx_kernel_security() -> Result<(), UringError> {
    if zcrx_kernel_security_override_enabled() {
        return Ok(());
    }
    let warnings = zcrx_kernel_security_warnings();
    if warnings.is_empty() {
        return Ok(());
    }
    Err(format!(
        "zero-copy receive requested but the running kernel matches known upstream ZCRX security advisory ranges: {}. Upgrade to a fixed kernel or set {ZCRX_KERNEL_SECURITY_OVERRIDE_ENV}=1 only when your distro kernel has the fixes backported.",
        warnings.join("; ")
    )
    .into())
}

fn zcrx_kernel_security_warnings() -> Vec<String> {
    zcrx_kernel_security_warnings_for_release(&kernel_release())
}

fn zcrx_kernel_security_warnings_for_release(release: &str) -> Vec<String> {
    let Some(version) = KernelVersion::parse(release) else {
        return Vec::new();
    };
    let mut warnings = Vec::new();
    if version.in_range(KernelVersion::new(6, 15, 0), KernelVersion::new(6, 18, 16))
        || version.in_range(KernelVersion::new(6, 19, 0), KernelVersion::new(6, 19, 6))
    {
        warnings.push(format!(
            "kernel release {release} matches the upstream affected range for CVE-2026-43121 in io_uring/zcrx; fixed upstream in 6.18.16, 6.19.6, and 7.0 or by vendor backport"
        ));
    }
    if version.in_range(KernelVersion::new(6, 15, 0), KernelVersion::new(6, 19, 6)) {
        warnings.push(format!(
            "kernel release {release} matches the upstream affected range for CVE-2026-43174 in io_uring/zcrx; fixed upstream in 6.19.6 and 7.0 or by vendor backport"
        ));
    }
    if version.in_range(KernelVersion::new(6, 18, 0), KernelVersion::new(6, 18, 16))
        || version.in_range(KernelVersion::new(6, 19, 0), KernelVersion::new(6, 19, 6))
    {
        warnings.push(format!(
            "kernel release {release} matches the upstream affected range for CVE-2026-43224 in io_uring/zcrx; fixed upstream in 6.18.16, 6.19.6, and 7.0 or by vendor backport"
        ));
    }
    if version.in_range(KernelVersion::new(6, 19, 0), KernelVersion::new(7, 0, 4)) {
        warnings.push(format!(
            "kernel release {release} matches the upstream affected range for CVE-2026-45995 in io_uring/zcrx; fixed upstream in 7.0.4 and 7.1 or by vendor backport"
        ));
    }
    warnings
}

fn zcrx_kernel_security_blocker_message(warning: &str) -> String {
    format!(
        "{warning}; set {ZCRX_KERNEL_SECURITY_OVERRIDE_ENV}=1 only after verifying a vendor backport"
    )
}

fn zcrx_kernel_security_override_enabled() -> bool {
    std::env::var(ZCRX_KERNEL_SECURITY_OVERRIDE_ENV)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct KernelVersion {
    major: u32,
    minor: u32,
    patch: u32,
}

impl KernelVersion {
    const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    fn parse(release: &str) -> Option<Self> {
        let prefix = release
            .chars()
            .take_while(|character| character.is_ascii_digit() || *character == '.')
            .collect::<String>();
        let mut parts = prefix.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        Some(Self::new(major, minor, patch))
    }

    fn in_range(self, start_inclusive: KernelVersion, end_exclusive: KernelVersion) -> bool {
        self >= start_inclusive && self < end_exclusive
    }
}

fn select_zcrx_queue(
    requested_interface: Option<String>,
    requested_rx_queue: Option<u32>,
) -> Result<(String, u32, u32), UringError> {
    let interface_name = requested_interface
        .or_else(default_zcrx_interface)
        .ok_or_else(|| {
            UringError("no network interface selected or discovered for ZCRX".to_string())
        })?;
    let interface_path = PathBuf::from("/sys/class/net").join(&interface_name);
    if !interface_path.exists() {
        return Err(
            format!("network interface {interface_name} does not exist in /sys/class/net").into(),
        );
    }
    let interface_index = interface_index(&interface_name).ok_or_else(|| {
        UringError(format!(
            "network interface index is unavailable for {interface_name}"
        ))
    })?;
    let rx_queue_count = count_rx_queues(&interface_path.join("queues"));
    if rx_queue_count == 0 {
        return Err(format!("no RX queues found for interface {interface_name}").into());
    }
    let rx_queue = requested_rx_queue.unwrap_or(0);
    if rx_queue >= rx_queue_count {
        return Err(format!(
            "RX queue {rx_queue} is outside discovered queue count {rx_queue_count} for interface {interface_name}"
        )
        .into());
    }

    Ok((interface_name, interface_index, rx_queue))
}

fn active_zcrx_registration_probe(
    interface_index: u32,
    rx_queue: u32,
    rx_buffer_size: u32,
) -> ZcrxActiveProbeResult {
    let ring = match build_zcrx_ring(8) {
        Ok(ring) => ring,
        Err(error) => {
            return ZcrxActiveProbeResult {
                message: format!(
                    "active ZCRX registration probe could not create ZCRX ring: {error}"
                ),
                errno: None,
                success: false,
            };
        }
    };

    match ZcrxRegistration::register_with_default_fallback(
        &ring,
        interface_index,
        rx_queue,
        ZCRX_PROBE_RQ_ENTRIES,
        rx_buffer_size,
    ) {
        Ok(result) => {
            let registration = result.registration;
            let fallback_note = result
                .fallback_from_rx_buffer_size
                .map(|(requested, error)| {
                    format!(
                        "; requested rx_buf_len {requested} failed ({error}) and kernel-default rx_buf_len fallback succeeded"
                    )
                })
                .unwrap_or_default();
            ZcrxActiveProbeResult {
                message: format!(
                    "active ZCRX ifq registration succeeded on ifindex {interface_index} rx queue {rx_queue}; requested_rx_buf_len={rx_buffer_size} effective_rx_buf_len={} short-lived zcrx_id={} rq_area_token={} offsets=head:{} tail:{} rqes:{} primed_refills:{} receive_area:{} refill_queue:{}{}",
                    registration.rx_buffer_size,
                    registration.zcrx_id,
                    registration.rq_area_token,
                    registration.offsets.head,
                    registration.offsets.tail,
                    registration.offsets.rqes,
                    registration.primed_refills,
                    registration.receive_area_len(),
                    registration.refill_queue_len(),
                    fallback_note
                ),
                errno: None,
                success: true,
            }
        }
        Err(error) => ZcrxActiveProbeResult {
            message: format!(
                "active ZCRX ifq registration failed on ifindex {interface_index} rx queue {rx_queue} requested_rx_buf_len={rx_buffer_size}: {error}"
            ),
            errno: error.errno(),
            success: false,
        },
    }
}

fn page_size() -> Option<usize> {
    // SAFETY: sysconf with _SC_PAGESIZE has no pointer arguments and does not
    // require additional process-side invariants.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    (size > 0).then_some(size as usize)
}

fn align_to_page(len: usize, page_size: usize) -> usize {
    debug_assert!(page_size.is_power_of_two());
    (len + page_size - 1) & !(page_size - 1)
}

fn probe_capabilities() -> Result<Capabilities, UringError> {
    let ring = IoUring::new(1)?;
    let mut probe = Probe::new();
    ring.submitter().register_probe(&mut probe)?;

    let (provided_buffer_ring, provided_buffer_ring_probe) = match ProvidedBufferRing::new(8, 1024)
        .and_then(|mut buf_ring| {
            let result = buf_ring.register(&ring);
            buf_ring.unregister(&ring);
            result
        }) {
        Ok(()) => (
            true,
            "active provided-buffer ring registration probe succeeded".to_string(),
        ),
        Err(error) => (
            false,
            format!("active provided-buffer ring registration probe failed: {error}"),
        ),
    };
    let (zcrx_cqe32_ring, zcrx_cqe32_ring_probe) = match probe_zcrx_cqe32_ring() {
        Ok(()) => (
            true,
            "CQE32/SINGLE_ISSUER/DEFER_TASKRUN ring setup and RecvZc SQE queue succeeded"
                .to_string(),
        ),
        Err(error) => (false, format!("CQE32 ZCRX ring setup failed: {error}")),
    };
    let (registered_send_buffer, registered_send_buffer_probe) =
        match probe_registered_send_buffer() {
            Ok(()) => (
                true,
                "active registered-buffer SEND probe succeeded".to_string(),
            ),
            Err(error) => (
                false,
                format!("active registered-buffer SEND probe failed: {error}"),
            ),
        };

    Ok(Capabilities {
        platform: std::env::consts::OS.to_string(),
        kernel_release: kernel_release(),
        io_uring_available: true,
        accept: probe.is_supported(opcode::Accept::CODE),
        accept_multi: probe.is_supported(opcode::AcceptMulti::CODE),
        recv: probe.is_supported(opcode::Recv::CODE),
        recv_multi: probe.is_supported(opcode::RecvMulti::CODE),
        provided_buffers: probe.is_supported(opcode::ProvideBuffers::CODE),
        provided_buffer_ring,
        provided_buffer_ring_probe,
        recv_bundle: ring.params().is_feature_recvsend_bundle(),
        send: probe.is_supported(opcode::Send::CODE),
        send_zc: probe.is_supported(opcode::SendZc::CODE),
        registered_send_buffer,
        registered_send_buffer_probe,
        recv_zc: probe.is_supported(opcode::RecvZc::CODE),
        zcrx_kernel_opcode: probe.is_supported(opcode::RecvZc::CODE),
        zcrx_cqe32_ring,
        zcrx_cqe32_ring_probe,
        zcrx_kernel_security_warnings: zcrx_kernel_security_warnings(),
        fast_poll: ring.params().is_feature_fast_poll(),
        note: "ZCRX opcode and CQE32 ring support only mean the kernel path can be prepared; NIC queue setup is separate. providedBufferRing and registeredSendBuffer are active probes."
            .to_string(),
    })
}

fn build_zcrx_ring(entries: u32) -> Result<ZcrxRing, UringError> {
    let mut builder = IoUring::<squeue::Entry, cqueue::Entry32>::builder();
    builder.setup_single_issuer();
    builder.setup_defer_taskrun();
    Ok(builder.build(entries)?)
}

fn probe_zcrx_cqe32_ring() -> Result<(), UringError> {
    let mut ring = build_zcrx_ring(8)?;
    submit_zcrx_recv_multi(&mut ring, -1, 1, 0, ZCRX_PROBE_BUFFER_SIZE as u32)?;
    Ok(())
}

fn probe_registered_send_buffer() -> Result<(), UringError> {
    let mut ring = IoUring::new(8)?;
    let mut probe = Probe::new();
    ring.submitter().register_probe(&mut probe)?;
    if !probe.is_supported(opcode::Send::CODE) {
        return Err("IORING_OP_SEND is unsupported".to_string().into());
    }

    let mut buffer = [0_u8; 64];
    let payload = b"ferrings registered send probe";
    buffer[..payload.len()].copy_from_slice(payload);
    let iovec = libc::iovec {
        iov_base: buffer.as_mut_ptr().cast::<libc::c_void>(),
        iov_len: buffer.len(),
    };
    // SAFETY: iovec points at `buffer`, which remains alive until the probe
    // completes and buffers are unregistered.
    unsafe {
        ring.submitter().register_buffers(&[iovec])?;
    }

    let mut sockets = [-1; 2];
    // SAFETY: sockets points at two valid RawFd slots for socketpair to fill,
    // and SOCK_CLOEXEC ensures the fds are not leaked across exec.
    let socket_result = unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
            0,
            sockets.as_mut_ptr(),
        )
    };
    if socket_result < 0 {
        let error = io::Error::last_os_error();
        let _ = ring.submitter().unregister_buffers();
        return Err(error.into());
    }

    let result =
        submit_registered_send_probe(&mut ring, sockets[0], buffer.as_ptr(), payload.len());
    close_raw_fd(sockets[0]);
    close_raw_fd(sockets[1]);
    let _ = ring.submitter().unregister_buffers();
    result
}

fn submit_registered_send_probe(
    ring: &mut Ring,
    fd: RawFd,
    ptr: *const u8,
    len: usize,
) -> Result<(), UringError> {
    let mut entry = opcode::Send::new(types::Fd(fd), ptr, len as u32)
        .flags(libc::MSG_NOSIGNAL)
        .build()
        .user_data(0xfeed_u64);
    set_send_fixed_buffer(&mut entry, 0);
    push_entry(ring, entry)?;
    ring.submit_and_wait(1)?;
    let cqe = ring
        .completion()
        .next()
        .ok_or_else(|| UringError("registered-buffer SEND probe produced no CQE".to_string()))?;
    match cqe.result() {
        result if result == len as i32 => Ok(()),
        result if result < 0 => {
            let errno = -result;
            Err(format!(
                "registered-buffer SEND completed with -{errno} ({})",
                io::Error::from_raw_os_error(errno)
            )
            .into())
        }
        result => Err(format!(
            "registered-buffer SEND completed with {result} bytes, expected {len}"
        )
        .into()),
    }
}

fn with_transport_stats(mut info: ServerInfo, stats: &TransportStats) -> ServerInfo {
    stats.apply_to_info(&mut info);
    info
}

fn resolve_recv_bundle<C: cqueue::EntryMarker>(
    requested: bool,
    ring: &Ring<C>,
    provided_buffer_ring: bool,
) -> Result<bool, UringError> {
    if !requested {
        return Ok(false);
    }
    if !ring.params().is_feature_recvsend_bundle() {
        return Err(
            "useRecvBundle requested but IORING_FEAT_RECVSEND_BUNDLE is unsupported"
                .to_string()
                .into(),
        );
    }
    if !provided_buffer_ring {
        return Err(
            "useRecvBundle requested but registered provided-buffer-ring setup was unavailable"
                .to_string()
                .into(),
        );
    }
    Ok(true)
}

fn setup_fixed_send_pool<C: cqueue::EntryMarker>(
    ring: &Ring<C>,
    config: &TcpServerConfig,
) -> Result<Option<FixedSendBufferPool>, UringError> {
    if !config.use_zero_copy_send && !config.use_registered_send_buffer {
        return Ok(None);
    }
    if config.use_registered_send_buffer {
        probe_registered_send_buffer().map_err(|error| {
            UringError(format!(
                "useRegisteredSendBuffer requested but active registered-buffer SEND probe failed: {error}"
            ))
        })?;
    }
    match FixedSendBufferPool::setup(
        ring,
        config.send_buffer_count as u16,
        config.send_buffer_size as usize,
    ) {
        Ok(pool) => Ok(Some(pool)),
        Err(error) if config.use_registered_send_buffer => Err(format!(
            "useRegisteredSendBuffer requested but fixed send buffer registration failed: {error}"
        )
        .into()),
        Err(_) => Ok(None),
    }
}

fn setup_response_send_buffer<C: cqueue::EntryMarker>(
    ring: &Ring<C>,
    response: &Arc<[u8]>,
    config: &ServerConfig,
) -> Result<bool, UringError> {
    if !config.use_zero_copy_send && !config.use_registered_send_buffer {
        return Ok(false);
    }
    if config.use_registered_send_buffer {
        probe_registered_send_buffer().map_err(|error| {
            UringError(format!(
                "useRegisteredSendBuffer requested but active registered-buffer SEND probe failed: {error}"
            ))
        })?;
    }
    match register_response_buffer(ring, response) {
        Ok(()) => Ok(true),
        Err(error) if config.use_registered_send_buffer => Err(format!(
            "useRegisteredSendBuffer requested but response buffer registration failed: {error}"
        )
        .into()),
        Err(_) => Ok(false),
    }
}

pub fn start_server(config: ServerConfig) -> Result<StartedServer, UringError> {
    let listener = bind_tcp_listener(
        config.host.as_str(),
        config.port,
        config.backlog,
        config.reuse_port,
        config.tcp_defer_accept_seconds,
        config.socket_recv_buffer_size,
        config.socket_send_buffer_size,
    )?;
    let local_addr = listener.local_addr()?;
    let listen_fd = listener.into_raw_fd();
    // SAFETY: eventfd has no pointer arguments here; the returned fd is checked
    // before use and owned by the server/worker lifecycle.
    let command_event_fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
    if command_event_fd < 0 {
        close_raw_fd(listen_fd);
        return Err(io::Error::last_os_error().into());
    }

    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_shutdown = Arc::clone(&shutdown);
    let worker_config = config.clone();
    let stats = Arc::new(TransportStats::default());
    let worker_stats = Arc::clone(&stats);
    let (ready_tx, ready_rx) = mpsc::channel::<Result<WorkerReady, String>>();

    let join = thread::Builder::new()
        .name("ferrings-io-uring".to_string())
        .spawn(move || {
            let _ = run_worker(
                listen_fd,
                command_event_fd,
                worker_config,
                worker_shutdown,
                ready_tx,
                worker_stats,
            );
        })
        .map_err(|error| {
            close_raw_fd(listen_fd);
            close_raw_fd(command_event_fd);
            UringError(error.to_string())
        })?;

    let worker_ready = match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(worker_ready)) => worker_ready,
        Ok(Err(error)) => {
            shutdown.store(true, Ordering::Release);
            wake_event_fd(command_event_fd);
            let _ = join.join();
            close_raw_fd(command_event_fd);
            return Err(error.into());
        }
        Err(error) => {
            shutdown.store(true, Ordering::Release);
            wake_event_fd(command_event_fd);
            let _ = join.join();
            close_raw_fd(command_event_fd);
            return Err(format!("io_uring worker did not start: {error}").into());
        }
    };

    let info = with_transport_stats(
        ServerInfo {
            host: local_addr.ip().to_string(),
            port: local_addr.port(),
            backend: "io_uring".to_string(),
            backlog: config.backlog,
            queue_depth: config.queue_depth,
            buffer_count: config.buffer_count,
            buffer_size: config.buffer_size,
            max_connections: config.max_connections,
            rejected_connections: 0.0,
            idle_timeout_ms: config.idle_timeout_ms,
            idle_timeouts: 0.0,
            tcp_no_delay: config.tcp_no_delay,
            reuse_port: config.reuse_port,
            tcp_defer_accept_seconds: config.tcp_defer_accept_seconds,
            socket_recv_buffer_size: config.socket_recv_buffer_size,
            socket_send_buffer_size: config.socket_send_buffer_size,
            command_queue_capacity: 0,
            command_queue_drops: 0.0,
            event_queue_capacity: 0,
            event_queue_drops: 0.0,
            event_batch_size: 0,
            send_queue_capacity: 0,
            send_queue_drops: 0.0,
            send_buffer_count: 0,
            send_buffer_size: 0,
            active_connections: 0.0,
            accepted_connections: 0.0,
            closed_connections: 0.0,
            bytes_received: 0.0,
            bytes_sent: 0.0,
            multishot_accept: true,
            multishot_recv: true,
            provided_buffer_ring: worker_ready.provided_buffer_ring,
            recv_bundle: worker_ready.recv_bundle,
            recv_bundle_completions: 0.0,
            recv_bundle_buffers: 0.0,
            recv_bundle_bytes: 0.0,
            recv_buffer_starvations: 0.0,
            recv_multishot_resubmits: 0.0,
            recv_copy_events: 0.0,
            recv_copy_bytes: 0.0,
            registered_send_buffer: worker_ready.registered_send_buffer,
            registered_send_requests: 0.0,
            registered_send_errors: 0.0,
            fixed_send_buffer_misses: 0.0,
            fixed_send_buffer_miss_bytes: 0.0,
            zero_copy_send: worker_ready.zero_copy_send,
            zero_copy_receive: config.use_zero_copy_receive,
            zcrx_ready: worker_ready.zcrx_ready,
            zcrx_rx_buffer_size: worker_ready.zcrx_rx_buffer_size,
            zcrx_packets: 0.0,
            zcrx_bytes: 0.0,
            zero_copy_send_requests: 0.0,
            zero_copy_send_notifications: 0.0,
            zero_copy_send_copied: 0.0,
            zero_copy_send_errors: 0.0,
        },
        &stats,
    );

    Ok(StartedServer {
        info,
        stats,
        shutdown,
        command_event_fd,
        join,
    })
}

pub fn start_tcp_echo_server(config: TcpServerConfig) -> Result<StartedServer, UringError> {
    let listener = bind_tcp_listener(
        config.host.as_str(),
        config.port,
        config.backlog,
        config.reuse_port,
        config.tcp_defer_accept_seconds,
        config.socket_recv_buffer_size,
        config.socket_send_buffer_size,
    )?;
    let local_addr = listener.local_addr()?;
    let listen_fd = listener.into_raw_fd();
    // SAFETY: eventfd has no pointer arguments here; the returned fd is checked
    // before use and owned by the server/worker lifecycle.
    let command_event_fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
    if command_event_fd < 0 {
        close_raw_fd(listen_fd);
        return Err(io::Error::last_os_error().into());
    }

    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_shutdown = Arc::clone(&shutdown);
    let worker_config = config.clone();
    let stats = Arc::new(TransportStats::default());
    let worker_stats = Arc::clone(&stats);
    let (ready_tx, ready_rx) = mpsc::channel::<Result<WorkerReady, String>>();

    let join = thread::Builder::new()
        .name("ferrings-tcp-echo-io-uring".to_string())
        .spawn(move || {
            let _ = run_tcp_echo_worker(
                listen_fd,
                command_event_fd,
                worker_config,
                worker_shutdown,
                ready_tx,
                worker_stats,
            );
        })
        .map_err(|error| {
            close_raw_fd(listen_fd);
            close_raw_fd(command_event_fd);
            UringError(error.to_string())
        })?;

    let worker_ready = match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(worker_ready)) => worker_ready,
        Ok(Err(error)) => {
            shutdown.store(true, Ordering::Release);
            wake_event_fd(command_event_fd);
            let _ = join.join();
            close_raw_fd(command_event_fd);
            return Err(error.into());
        }
        Err(error) => {
            shutdown.store(true, Ordering::Release);
            wake_event_fd(command_event_fd);
            let _ = join.join();
            close_raw_fd(command_event_fd);
            return Err(format!("io_uring TCP echo worker did not start: {error}").into());
        }
    };

    let info = with_transport_stats(
        ServerInfo {
            host: local_addr.ip().to_string(),
            port: local_addr.port(),
            backend: "io_uring".to_string(),
            backlog: config.backlog,
            queue_depth: config.queue_depth,
            buffer_count: config.buffer_count,
            buffer_size: config.buffer_size,
            max_connections: config.max_connections,
            rejected_connections: 0.0,
            idle_timeout_ms: config.idle_timeout_ms,
            idle_timeouts: 0.0,
            tcp_no_delay: config.tcp_no_delay,
            reuse_port: config.reuse_port,
            tcp_defer_accept_seconds: config.tcp_defer_accept_seconds,
            socket_recv_buffer_size: config.socket_recv_buffer_size,
            socket_send_buffer_size: config.socket_send_buffer_size,
            command_queue_capacity: 0,
            command_queue_drops: 0.0,
            event_queue_capacity: 0,
            event_queue_drops: 0.0,
            event_batch_size: 0,
            send_queue_capacity: config.send_queue_capacity,
            send_queue_drops: 0.0,
            send_buffer_count: config.send_buffer_count,
            send_buffer_size: config.send_buffer_size,
            active_connections: 0.0,
            accepted_connections: 0.0,
            closed_connections: 0.0,
            bytes_received: 0.0,
            bytes_sent: 0.0,
            multishot_accept: true,
            multishot_recv: true,
            provided_buffer_ring: worker_ready.provided_buffer_ring,
            recv_bundle: worker_ready.recv_bundle,
            recv_bundle_completions: 0.0,
            recv_bundle_buffers: 0.0,
            recv_bundle_bytes: 0.0,
            recv_buffer_starvations: 0.0,
            recv_multishot_resubmits: 0.0,
            recv_copy_events: 0.0,
            recv_copy_bytes: 0.0,
            registered_send_buffer: worker_ready.registered_send_buffer,
            registered_send_requests: 0.0,
            registered_send_errors: 0.0,
            fixed_send_buffer_misses: 0.0,
            fixed_send_buffer_miss_bytes: 0.0,
            zero_copy_send: worker_ready.zero_copy_send,
            zero_copy_receive: config.use_zero_copy_receive,
            zcrx_ready: worker_ready.zcrx_ready,
            zcrx_rx_buffer_size: worker_ready.zcrx_rx_buffer_size,
            zcrx_packets: 0.0,
            zcrx_bytes: 0.0,
            zero_copy_send_requests: 0.0,
            zero_copy_send_notifications: 0.0,
            zero_copy_send_copied: 0.0,
            zero_copy_send_errors: 0.0,
        },
        &stats,
    );

    Ok(StartedServer {
        info,
        stats,
        shutdown,
        command_event_fd,
        join,
    })
}

pub fn start_tcp_server(
    config: TcpServerConfig,
    event_sink: TcpEventSink,
) -> Result<StartedTcpServer, UringError> {
    let listener = bind_tcp_listener(
        config.host.as_str(),
        config.port,
        config.backlog,
        config.reuse_port,
        config.tcp_defer_accept_seconds,
        config.socket_recv_buffer_size,
        config.socket_send_buffer_size,
    )?;
    let local_addr = listener.local_addr()?;
    let listen_fd = listener.into_raw_fd();
    // SAFETY: eventfd has no pointer arguments here; the returned fd is checked
    // before use and owned by the server/worker lifecycle.
    let command_event_fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
    if command_event_fd < 0 {
        close_raw_fd(listen_fd);
        return Err(io::Error::last_os_error().into());
    }

    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_shutdown = Arc::clone(&shutdown);
    let worker_config = config.clone();
    let stats = Arc::new(TransportStats::default());
    let worker_stats = Arc::clone(&stats);
    let (ready_tx, ready_rx) = mpsc::channel::<Result<WorkerReady, String>>();
    let (command_tx, command_rx) =
        mpsc::sync_channel::<TcpCommand>(config.command_queue_capacity as usize);

    let join = thread::Builder::new()
        .name("ferrings-tcp-io-uring".to_string())
        .spawn(move || {
            let runtime = TcpWorkerRuntime {
                shutdown: worker_shutdown,
                ready_tx: Some(ready_tx),
                command_rx,
                event_sink,
                stats: worker_stats,
            };
            let _ = run_tcp_worker(listen_fd, command_event_fd, worker_config, runtime);
        })
        .map_err(|error| {
            close_raw_fd(listen_fd);
            close_raw_fd(command_event_fd);
            UringError(error.to_string())
        })?;

    let worker_ready = match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(worker_ready)) => worker_ready,
        Ok(Err(error)) => {
            shutdown.store(true, Ordering::Release);
            wake_event_fd(command_event_fd);
            let _ = join.join();
            close_raw_fd(command_event_fd);
            return Err(error.into());
        }
        Err(error) => {
            shutdown.store(true, Ordering::Release);
            wake_event_fd(command_event_fd);
            let _ = join.join();
            close_raw_fd(command_event_fd);
            return Err(format!("io_uring TCP worker did not start: {error}").into());
        }
    };

    let info = with_transport_stats(
        ServerInfo {
            host: local_addr.ip().to_string(),
            port: local_addr.port(),
            backend: "io_uring".to_string(),
            backlog: config.backlog,
            queue_depth: config.queue_depth,
            buffer_count: config.buffer_count,
            buffer_size: config.buffer_size,
            max_connections: config.max_connections,
            rejected_connections: 0.0,
            idle_timeout_ms: config.idle_timeout_ms,
            idle_timeouts: 0.0,
            tcp_no_delay: config.tcp_no_delay,
            reuse_port: config.reuse_port,
            tcp_defer_accept_seconds: config.tcp_defer_accept_seconds,
            socket_recv_buffer_size: config.socket_recv_buffer_size,
            socket_send_buffer_size: config.socket_send_buffer_size,
            command_queue_capacity: config.command_queue_capacity,
            command_queue_drops: 0.0,
            event_queue_capacity: config.event_queue_capacity,
            event_queue_drops: 0.0,
            event_batch_size: config.event_batch_size,
            send_queue_capacity: config.send_queue_capacity,
            send_queue_drops: 0.0,
            send_buffer_count: config.send_buffer_count,
            send_buffer_size: config.send_buffer_size,
            active_connections: 0.0,
            accepted_connections: 0.0,
            closed_connections: 0.0,
            bytes_received: 0.0,
            bytes_sent: 0.0,
            multishot_accept: true,
            multishot_recv: true,
            provided_buffer_ring: worker_ready.provided_buffer_ring,
            recv_bundle: worker_ready.recv_bundle,
            recv_bundle_completions: 0.0,
            recv_bundle_buffers: 0.0,
            recv_bundle_bytes: 0.0,
            recv_buffer_starvations: 0.0,
            recv_multishot_resubmits: 0.0,
            recv_copy_events: 0.0,
            recv_copy_bytes: 0.0,
            registered_send_buffer: worker_ready.registered_send_buffer,
            registered_send_requests: 0.0,
            registered_send_errors: 0.0,
            fixed_send_buffer_misses: 0.0,
            fixed_send_buffer_miss_bytes: 0.0,
            zero_copy_send: worker_ready.zero_copy_send,
            zero_copy_receive: config.use_zero_copy_receive,
            zcrx_ready: worker_ready.zcrx_ready,
            zcrx_rx_buffer_size: worker_ready.zcrx_rx_buffer_size,
            zcrx_packets: 0.0,
            zcrx_bytes: 0.0,
            zero_copy_send_requests: 0.0,
            zero_copy_send_notifications: 0.0,
            zero_copy_send_copied: 0.0,
            zero_copy_send_errors: 0.0,
        },
        &stats,
    );

    Ok(StartedTcpServer {
        info,
        stats,
        shutdown,
        command_tx,
        command_event_fd,
        join,
    })
}

fn run_worker(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: ServerConfig,
    shutdown: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<WorkerReady, String>>,
    stats: Arc<TransportStats>,
) -> Result<(), UringError> {
    let mut ready_tx = Some(ready_tx);
    let result = run_worker_inner(
        listen_fd,
        command_event_fd,
        config,
        shutdown,
        &mut ready_tx,
        &stats,
    );
    if let Err(error) = &result {
        if let Some(ready_tx) = ready_tx.take() {
            let _ = ready_tx.send(Err(error.to_string()));
        }
    }
    close_raw_fd(listen_fd);
    result
}

fn run_tcp_echo_worker(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: TcpServerConfig,
    shutdown: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<WorkerReady, String>>,
    stats: Arc<TransportStats>,
) -> Result<(), UringError> {
    let mut ready_tx = Some(ready_tx);
    let result = run_tcp_echo_worker_inner(
        listen_fd,
        command_event_fd,
        config,
        shutdown,
        &mut ready_tx,
        &stats,
    );
    if let Err(error) = &result {
        if let Some(ready_tx) = ready_tx.take() {
            let _ = ready_tx.send(Err(error.to_string()));
        }
    }
    close_raw_fd(listen_fd);
    result
}

fn run_tcp_worker(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: TcpServerConfig,
    mut runtime: TcpWorkerRuntime,
) -> Result<(), UringError> {
    let result = run_tcp_worker_inner(listen_fd, command_event_fd, config, &mut runtime);
    if let Err(error) = &result {
        if let Some(ready_tx) = runtime.ready_tx.take() {
            let _ = ready_tx.send(Err(error.to_string()));
        }
    }
    close_raw_fd(listen_fd);
    result
}

fn run_worker_zcrx_inner(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: ServerConfig,
    shutdown: Arc<AtomicBool>,
    ready_tx: &mut Option<mpsc::Sender<Result<WorkerReady, String>>>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    ensure_zcrx_kernel_security()?;
    let mut ring = build_zcrx_ring(config.queue_depth)?;

    let mut probe = Probe::new();
    ring.submitter().register_probe(&mut probe)?;
    if !probe.is_supported(opcode::Accept::CODE) || !probe.is_supported(opcode::RecvZc::CODE) {
        return Err(
            "zero-copy receive requested but accept/IORING_OP_RECV_ZC support is unavailable"
                .to_string()
                .into(),
        );
    }
    if !probe.is_supported(opcode::Send::CODE) {
        return Err("kernel does not support send io_uring opcode"
            .to_string()
            .into());
    }
    if config.use_zero_copy_send && !probe.is_supported(opcode::SendZc::CODE) {
        return Err(
            "zero-copy send requested but IORING_OP_SEND_ZC is unsupported"
                .to_string()
                .into(),
        );
    }

    let (interface_name, interface_index, rx_queue) =
        select_zcrx_queue(config.zcrx_interface_name.clone(), config.zcrx_rx_queue).map_err(
            |error| {
                UringError(format!(
                    "zero-copy receive requested but active ZCRX readiness probe failed: {error}"
                ))
            },
        )?;
    let registration_result = ZcrxRegistration::register_with_default_fallback(
        &ring,
        interface_index,
        rx_queue,
        config.buffer_count,
        config.zcrx_rx_buffer_size,
    )
    .map_err(|error| {
        UringError(format!(
            "zero-copy receive requested but active ZCRX readiness probe failed for interface {interface_name} (ifindex {interface_index}, rx queue {rx_queue}): {error}"
        ))
    })?;
    let mut zcrx = registration_result.registration;
    let zcrx_rx_buffer_size = zcrx.rx_buffer_size;

    let response = Arc::<[u8]>::from(make_response(&config.response_body));
    let registered_send_buffer = setup_response_send_buffer(&ring, &response, &config)?;
    let mut connections = HashMap::<RawFd, Connection>::new();
    let mut id_to_fd = HashMap::<u32, RawFd>::new();
    let mut next_connection_id = 1_u32;
    let mut command_counter = Box::new(0_u64);

    submit_accept_multi(&mut ring, listen_fd)?;
    submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
    ring.submit()?;
    if let Some(ready_tx) = ready_tx.take() {
        let _ = ready_tx.send(Ok(WorkerReady {
            provided_buffer_ring: false,
            recv_bundle: false,
            registered_send_buffer,
            zero_copy_send: config.use_zero_copy_send,
            zcrx_ready: true,
            zcrx_rx_buffer_size,
        }));
    }

    while !shutdown.load(Ordering::Acquire) {
        close_idle_connections(
            &mut connections,
            &mut id_to_fd,
            stats,
            config.idle_timeout_ms,
        );
        wait_for_completions(&ring)?;

        let completions: Vec<_> = ring.completion().collect();
        for cqe in completions {
            if cqe.flags() & IORING_CQE_F_SKIP != 0 {
                continue;
            }
            let (op, token) = unpack_user_data(cqe.user_data());
            match op {
                OP_ACCEPT => {
                    let mut accept_context = AcceptContext {
                        connections: &mut connections,
                        id_to_fd: &mut id_to_fd,
                        next_connection_id: &mut next_connection_id,
                        buffer_size: zcrx_rx_buffer_size,
                        use_recv_bundle: false,
                        max_connections: config.max_connections,
                        tcp_no_delay: config.tcp_no_delay,
                        socket_recv_buffer_size: config.socket_recv_buffer_size,
                        socket_send_buffer_size: config.socket_send_buffer_size,
                        stats,
                    };
                    handle_zcrx_accept(
                        &mut ring,
                        listen_fd,
                        cqe.result(),
                        cqe.flags(),
                        zcrx.zcrx_id,
                        &mut accept_context,
                    )?;
                }
                OP_RECV => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = id_to_fd.get(&connection_id) else {
                        if cqe.result() > 0 {
                            if let Some(packet) = zcrx.decode_packet(&cqe)? {
                                zcrx.recycle_packet(packet)?;
                            }
                        }
                        continue;
                    };
                    let mut recv_context = ZcrxRecvContext {
                        zcrx: &mut zcrx,
                        connections: &mut connections,
                        id_to_fd: &mut id_to_fd,
                        response: &response,
                        stats,
                        use_zero_copy_send: config.use_zero_copy_send,
                        registered_send_buffer,
                        buffer_size: zcrx_rx_buffer_size,
                    };
                    handle_zcrx_recv(&mut ring, fd, connection_id, &cqe, &mut recv_context)?;
                }
                OP_SEND if !cqueue::notif(cqe.flags()) => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = id_to_fd.get(&connection_id) else {
                        continue;
                    };
                    let mut send_context = SendContext {
                        connections: &mut connections,
                        id_to_fd: &mut id_to_fd,
                        response: &response,
                        stats,
                        use_zero_copy_send: config.use_zero_copy_send,
                        registered_send_buffer,
                    };
                    handle_send(
                        &mut ring,
                        fd,
                        connection_id,
                        cqe.result(),
                        &mut send_context,
                    )?;
                }
                OP_SEND => {
                    stats.record_zero_copy_send_notification(cqe.result());
                }
                OP_COMMAND => {
                    handle_command_completion(cqe.result())?;
                    *command_counter = 0;
                    if !shutdown.load(Ordering::Acquire) {
                        submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
                    }
                }
                _ => {}
            }
        }

        ring.submit()?;
    }

    for fd in connections.keys().copied().collect::<Vec<_>>() {
        close_connection(fd, &mut connections, &mut id_to_fd, stats);
    }
    if registered_send_buffer {
        let _ = ring.submitter().unregister_buffers();
    }
    Ok(())
}

fn run_worker_inner(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: ServerConfig,
    shutdown: Arc<AtomicBool>,
    ready_tx: &mut Option<mpsc::Sender<Result<WorkerReady, String>>>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    if config.use_zero_copy_receive {
        return run_worker_zcrx_inner(
            listen_fd,
            command_event_fd,
            config,
            shutdown,
            ready_tx,
            stats,
        );
    }

    let mut ring = IoUring::new(config.queue_depth)?;

    let mut probe = Probe::new();
    ring.submitter().register_probe(&mut probe)?;
    if !probe.is_supported(opcode::Accept::CODE) || !probe.is_supported(opcode::Recv::CODE) {
        return Err("kernel does not support accept/recv io_uring opcodes"
            .to_string()
            .into());
    }
    if !probe.is_supported(opcode::Send::CODE) {
        return Err("kernel does not support send io_uring opcode"
            .to_string()
            .into());
    }
    if config.use_zero_copy_send && !probe.is_supported(opcode::SendZc::CODE) {
        return Err(
            "zero-copy send requested but IORING_OP_SEND_ZC is unsupported"
                .to_string()
                .into(),
        );
    }
    let mut buffers = BufferPool::setup(
        &mut ring,
        config.buffer_count as u16,
        config.buffer_size as usize,
    )?;
    let provided_buffer_ring = buffers.provided_buffer_ring();
    let use_recv_bundle = resolve_recv_bundle(config.use_recv_bundle, &ring, provided_buffer_ring)?;

    let response = Arc::<[u8]>::from(make_response(&config.response_body));
    let registered_send_buffer = setup_response_send_buffer(&ring, &response, &config)?;
    let mut connections = HashMap::<RawFd, Connection>::new();
    let mut id_to_fd = HashMap::<u32, RawFd>::new();
    let mut next_connection_id = 1_u32;
    let mut command_counter = Box::new(0_u64);

    submit_accept_multi(&mut ring, listen_fd)?;
    submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
    ring.submit()?;
    if let Some(ready_tx) = ready_tx.take() {
        let _ = ready_tx.send(Ok(WorkerReady {
            provided_buffer_ring,
            recv_bundle: use_recv_bundle,
            registered_send_buffer,
            zero_copy_send: config.use_zero_copy_send,
            zcrx_ready: false,
            zcrx_rx_buffer_size: 0,
        }));
    }

    while !shutdown.load(Ordering::Acquire) {
        close_idle_connections(
            &mut connections,
            &mut id_to_fd,
            stats,
            config.idle_timeout_ms,
        );
        wait_for_completions(&ring)?;

        let completions: Vec<_> = ring
            .completion()
            .map(|cqe| {
                (
                    cqe.user_data(),
                    cqe.result(),
                    cqe.flags(),
                    cqueue::notif(cqe.flags()),
                )
            })
            .collect();

        for (user_data, result, flags, is_notification) in completions {
            let (op, token) = unpack_user_data(user_data);
            match op {
                OP_ACCEPT => {
                    let mut accept_context = AcceptContext {
                        connections: &mut connections,
                        id_to_fd: &mut id_to_fd,
                        next_connection_id: &mut next_connection_id,
                        buffer_size: config.buffer_size,
                        use_recv_bundle,
                        max_connections: config.max_connections,
                        tcp_no_delay: config.tcp_no_delay,
                        socket_recv_buffer_size: config.socket_recv_buffer_size,
                        socket_send_buffer_size: config.socket_send_buffer_size,
                        stats,
                    };
                    handle_accept(&mut ring, listen_fd, result, flags, &mut accept_context)?;
                }
                OP_RECV => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = id_to_fd.get(&connection_id) else {
                        if result > 0 {
                            if let Some(bid) = cqueue::buffer_select(flags) {
                                buffers.discard_recv(
                                    &mut ring,
                                    bid,
                                    result as usize,
                                    use_recv_bundle,
                                    stats,
                                )?;
                            }
                        }
                        continue;
                    };
                    let mut recv_context = RecvContext {
                        buffers: &mut buffers,
                        connections: &mut connections,
                        id_to_fd: &mut id_to_fd,
                        response: &response,
                        stats,
                        use_recv_bundle,
                        use_zero_copy_send: config.use_zero_copy_send,
                        registered_send_buffer,
                        buffer_size: config.buffer_size,
                    };
                    handle_recv(
                        &mut ring,
                        fd,
                        connection_id,
                        result,
                        flags,
                        &mut recv_context,
                    )?;
                }
                OP_SEND => {
                    if !is_notification {
                        let connection_id = unpack_connection_id(token);
                        let Some(&fd) = id_to_fd.get(&connection_id) else {
                            continue;
                        };
                        let mut send_context = SendContext {
                            connections: &mut connections,
                            id_to_fd: &mut id_to_fd,
                            response: &response,
                            stats,
                            use_zero_copy_send: config.use_zero_copy_send,
                            registered_send_buffer,
                        };
                        handle_send(&mut ring, fd, connection_id, result, &mut send_context)?;
                    } else {
                        stats.record_zero_copy_send_notification(result);
                    }
                }
                OP_PROVIDE if result < 0 => {
                    return Err(io::Error::from_raw_os_error(-result).into());
                }
                OP_COMMAND => {
                    handle_command_completion(result)?;
                    *command_counter = 0;
                    if !shutdown.load(Ordering::Acquire) {
                        submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
                    }
                }
                _ => {}
            }
        }

        ring.submit()?;
    }

    for fd in connections.keys().copied().collect::<Vec<_>>() {
        close_connection(fd, &mut connections, &mut id_to_fd, stats);
    }
    if registered_send_buffer {
        let _ = ring.submitter().unregister_buffers();
    }
    buffers.unregister(&ring);
    Ok(())
}

fn run_tcp_echo_zcrx_worker_inner(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: TcpServerConfig,
    shutdown: Arc<AtomicBool>,
    ready_tx: &mut Option<mpsc::Sender<Result<WorkerReady, String>>>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    ensure_zcrx_kernel_security()?;
    let mut ring = build_zcrx_ring(config.queue_depth)?;

    let mut probe = Probe::new();
    ring.submitter().register_probe(&mut probe)?;
    if !probe.is_supported(opcode::Accept::CODE) || !probe.is_supported(opcode::RecvZc::CODE) {
        return Err(
            "zero-copy receive requested but accept/IORING_OP_RECV_ZC support is unavailable"
                .to_string()
                .into(),
        );
    }
    if !probe.is_supported(opcode::Send::CODE) {
        return Err("kernel does not support send io_uring opcode"
            .to_string()
            .into());
    }
    if config.use_zero_copy_send && !probe.is_supported(opcode::SendZc::CODE) {
        return Err(
            "zero-copy send requested but IORING_OP_SEND_ZC is unsupported"
                .to_string()
                .into(),
        );
    }

    let (interface_name, interface_index, rx_queue) =
        select_zcrx_queue(config.zcrx_interface_name.clone(), config.zcrx_rx_queue).map_err(
            |error| {
                UringError(format!(
                    "zero-copy receive requested but active ZCRX readiness probe failed: {error}"
                ))
            },
        )?;
    let registration_result = ZcrxRegistration::register_with_default_fallback(
        &ring,
        interface_index,
        rx_queue,
        config.buffer_count,
        config.zcrx_rx_buffer_size,
    )
    .map_err(|error| {
        UringError(format!(
            "zero-copy receive requested but active ZCRX readiness probe failed for interface {interface_name} (ifindex {interface_index}, rx queue {rx_queue}): {error}"
        ))
    })?;
    let mut zcrx = registration_result.registration;
    let zcrx_rx_buffer_size = zcrx.rx_buffer_size;

    let mut fixed_send_pool = setup_fixed_send_pool(&ring, &config)?;
    let registered_send_buffer = fixed_send_pool.is_some();
    let use_zero_copy_send = config.use_zero_copy_send;
    let use_registered_send_buffer = config.use_registered_send_buffer && registered_send_buffer;
    let mut state = TcpWorkerState::default();
    let mut event_emitter = TcpEventEmitter::none();
    let mut command_counter = Box::new(0_u64);

    submit_accept_multi(&mut ring, listen_fd)?;
    submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
    ring.submit()?;
    if let Some(ready_tx) = ready_tx.take() {
        let _ = ready_tx.send(Ok(WorkerReady {
            provided_buffer_ring: false,
            recv_bundle: false,
            registered_send_buffer,
            zero_copy_send: use_zero_copy_send,
            zcrx_ready: true,
            zcrx_rx_buffer_size,
        }));
    }

    while !shutdown.load(Ordering::Acquire) {
        close_idle_tcp_connections(
            &mut state,
            &mut event_emitter,
            fixed_send_pool.as_mut(),
            false,
            stats,
            config.idle_timeout_ms,
        )?;
        wait_for_completions(&ring)?;

        let completions: Vec<_> = ring.completion().collect();
        for cqe in completions {
            if cqe.flags() & IORING_CQE_F_SKIP != 0 {
                continue;
            }
            let (op, token) = unpack_user_data(cqe.user_data());
            match op {
                OP_ACCEPT => {
                    let mut accept_context = TcpZcrxAcceptContext {
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        zcrx_id: zcrx.zcrx_id,
                        buffer_size: zcrx_rx_buffer_size,
                        max_connections: config.max_connections,
                        tcp_no_delay: config.tcp_no_delay,
                        socket_recv_buffer_size: config.socket_recv_buffer_size,
                        socket_send_buffer_size: config.socket_send_buffer_size,
                        stats,
                    };
                    handle_tcp_zcrx_accept(
                        &mut ring,
                        listen_fd,
                        cqe.result(),
                        cqe.flags(),
                        &mut accept_context,
                    )?;
                }
                OP_RECV => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                        if cqe.result() > 0 {
                            if let Some(packet) = zcrx.decode_packet(&cqe)? {
                                zcrx.recycle_packet(packet)?;
                            }
                        }
                        continue;
                    };
                    let mut recv_context = TcpZcrxEchoRecvContext {
                        zcrx: &mut zcrx,
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        buffer_size: zcrx_rx_buffer_size,
                        send_queue_capacity: config.send_queue_capacity,
                        stats,
                        use_registered_send_buffer,
                        use_zero_copy_send,
                    };
                    handle_tcp_echo_zcrx_recv(
                        &mut ring,
                        fd,
                        connection_id,
                        &cqe,
                        &mut recv_context,
                    )?;
                }
                OP_SEND => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                        continue;
                    };
                    let is_notification = cqueue::notif(cqe.flags());
                    let mut send_context = TcpSendContext {
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        stats,
                    };
                    handle_tcp_send(
                        &mut ring,
                        fd,
                        cqe.result(),
                        cqe.flags(),
                        is_notification,
                        &mut send_context,
                    )?;
                }
                OP_COMMAND => {
                    handle_command_completion(cqe.result())?;
                    *command_counter = 0;
                    if !shutdown.load(Ordering::Acquire) {
                        submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
                    }
                }
                _ => {}
            }
        }

        ring.submit()?;
    }

    drain_tcp_shutdown_sends(
        &mut ring,
        &mut state,
        &mut event_emitter,
        fixed_send_pool.as_mut(),
        stats,
    )?;
    event_emitter.flush()?;
    if registered_send_buffer {
        let _ = ring.submitter().unregister_buffers();
    }
    Ok(())
}

fn run_tcp_echo_worker_inner(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: TcpServerConfig,
    shutdown: Arc<AtomicBool>,
    ready_tx: &mut Option<mpsc::Sender<Result<WorkerReady, String>>>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    if config.use_zero_copy_receive {
        return run_tcp_echo_zcrx_worker_inner(
            listen_fd,
            command_event_fd,
            config,
            shutdown,
            ready_tx,
            stats,
        );
    }

    let mut ring = IoUring::new(config.queue_depth)?;

    let mut probe = Probe::new();
    ring.submitter().register_probe(&mut probe)?;
    if !probe.is_supported(opcode::Accept::CODE) || !probe.is_supported(opcode::Recv::CODE) {
        return Err("kernel does not support accept/recv io_uring opcodes"
            .to_string()
            .into());
    }
    if !probe.is_supported(opcode::Send::CODE) {
        return Err("kernel does not support send io_uring opcode"
            .to_string()
            .into());
    }
    if config.use_zero_copy_send && !probe.is_supported(opcode::SendZc::CODE) {
        return Err(
            "zero-copy send requested but IORING_OP_SEND_ZC is unsupported"
                .to_string()
                .into(),
        );
    }
    let mut buffers = BufferPool::setup(
        &mut ring,
        config.buffer_count as u16,
        config.buffer_size as usize,
    )?;
    let provided_buffer_ring = buffers.provided_buffer_ring();
    let use_recv_bundle = resolve_recv_bundle(config.use_recv_bundle, &ring, provided_buffer_ring)?;
    let mut fixed_send_pool = setup_fixed_send_pool(&ring, &config)?;
    let registered_send_buffer = fixed_send_pool.is_some();
    let use_zero_copy_send = config.use_zero_copy_send;
    let use_registered_send_buffer = config.use_registered_send_buffer && registered_send_buffer;
    let mut state = TcpWorkerState::default();
    let mut event_emitter = TcpEventEmitter::none();
    let mut command_counter = Box::new(0_u64);

    submit_accept_multi(&mut ring, listen_fd)?;
    submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
    ring.submit()?;
    if let Some(ready_tx) = ready_tx.take() {
        let _ = ready_tx.send(Ok(WorkerReady {
            provided_buffer_ring,
            recv_bundle: use_recv_bundle,
            registered_send_buffer,
            zero_copy_send: use_zero_copy_send,
            zcrx_ready: false,
            zcrx_rx_buffer_size: 0,
        }));
    }

    while !shutdown.load(Ordering::Acquire) {
        close_idle_tcp_connections(
            &mut state,
            &mut event_emitter,
            fixed_send_pool.as_mut(),
            false,
            stats,
            config.idle_timeout_ms,
        )?;
        wait_for_completions(&ring)?;

        let completions: Vec<_> = ring
            .completion()
            .map(|cqe| (cqe.user_data(), cqe.result(), cqe.flags()))
            .collect();

        for (user_data, result, flags) in completions {
            let (op, token) = unpack_user_data(user_data);
            match op {
                OP_ACCEPT => {
                    let mut accept_context = TcpAcceptContext {
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        buffer_size: config.buffer_size,
                        use_recv_bundle,
                        max_connections: config.max_connections,
                        tcp_no_delay: config.tcp_no_delay,
                        socket_recv_buffer_size: config.socket_recv_buffer_size,
                        socket_send_buffer_size: config.socket_send_buffer_size,
                        stats,
                    };
                    handle_tcp_accept(&mut ring, listen_fd, result, flags, &mut accept_context)?;
                }
                OP_RECV => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                        if result > 0 {
                            if let Some(bid) = cqueue::buffer_select(flags) {
                                buffers.discard_recv(
                                    &mut ring,
                                    bid,
                                    result as usize,
                                    use_recv_bundle,
                                    stats,
                                )?;
                            }
                        }
                        continue;
                    };
                    let mut recv_context = TcpEchoRecvContext {
                        buffers: &mut buffers,
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        buffer_size: config.buffer_size,
                        send_queue_capacity: config.send_queue_capacity,
                        stats,
                        use_recv_bundle,
                        use_registered_send_buffer,
                        use_zero_copy_send,
                    };
                    handle_tcp_echo_recv(
                        &mut ring,
                        fd,
                        connection_id,
                        result,
                        flags,
                        &mut recv_context,
                    )?;
                }
                OP_SEND => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                        continue;
                    };
                    let is_notification = cqueue::notif(flags);
                    let mut send_context = TcpSendContext {
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        stats,
                    };
                    handle_tcp_send(
                        &mut ring,
                        fd,
                        result,
                        flags,
                        is_notification,
                        &mut send_context,
                    )?;
                }
                OP_PROVIDE if result < 0 => {
                    return Err(io::Error::from_raw_os_error(-result).into());
                }
                OP_COMMAND => {
                    handle_command_completion(result)?;
                    *command_counter = 0;
                    if !shutdown.load(Ordering::Acquire) {
                        submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
                    }
                }
                _ => {}
            }
        }

        ring.submit()?;
    }

    drain_tcp_shutdown_sends(
        &mut ring,
        &mut state,
        &mut event_emitter,
        fixed_send_pool.as_mut(),
        stats,
    )?;
    if registered_send_buffer {
        let _ = ring.submitter().unregister_buffers();
    }
    buffers.unregister(&ring);
    Ok(())
}

fn run_tcp_zcrx_worker_inner(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: TcpServerConfig,
    runtime: &mut TcpWorkerRuntime,
) -> Result<(), UringError> {
    ensure_zcrx_kernel_security()?;
    let mut ring = build_zcrx_ring(config.queue_depth)?;

    let mut probe = Probe::new();
    ring.submitter().register_probe(&mut probe)?;
    if !probe.is_supported(opcode::Accept::CODE) || !probe.is_supported(opcode::RecvZc::CODE) {
        return Err(
            "zero-copy receive requested but accept/IORING_OP_RECV_ZC support is unavailable"
                .to_string()
                .into(),
        );
    }
    if !probe.is_supported(opcode::Send::CODE) || !probe.is_supported(opcode::Read::CODE) {
        return Err("kernel does not support send/read io_uring opcodes"
            .to_string()
            .into());
    }
    if config.use_zero_copy_send && !probe.is_supported(opcode::SendZc::CODE) {
        return Err(
            "zero-copy send requested but IORING_OP_SEND_ZC is unsupported"
                .to_string()
                .into(),
        );
    }

    let (interface_name, interface_index, rx_queue) =
        select_zcrx_queue(config.zcrx_interface_name.clone(), config.zcrx_rx_queue).map_err(
            |error| {
                UringError(format!(
                    "zero-copy receive requested but active ZCRX readiness probe failed: {error}"
                ))
            },
        )?;
    let registration_result = ZcrxRegistration::register_with_default_fallback(
        &ring,
        interface_index,
        rx_queue,
        config.buffer_count,
        config.zcrx_rx_buffer_size,
    )
    .map_err(|error| {
        UringError(format!(
            "zero-copy receive requested but active ZCRX readiness probe failed for interface {interface_name} (ifindex {interface_index}, rx queue {rx_queue}): {error}"
        ))
    })?;
    let mut zcrx = registration_result.registration;
    let zcrx_rx_buffer_size = zcrx.rx_buffer_size;

    let mut fixed_send_pool = setup_fixed_send_pool(&ring, &config)?;
    let registered_send_buffer = fixed_send_pool.is_some();
    let use_zero_copy_send = config.use_zero_copy_send;
    let use_registered_send_buffer = config.use_registered_send_buffer && registered_send_buffer;
    let send_options = TcpSendOptions {
        use_registered_send_buffer,
        use_zero_copy_send,
    };
    let mut command_counter = Box::new(0_u64);
    let mut state = TcpWorkerState::default();
    let mut event_emitter = TcpEventEmitter::new(
        std::mem::replace(&mut runtime.event_sink, TcpEventSink::None),
        Arc::clone(&runtime.stats),
        config.event_queue_capacity,
        config.event_batch_size,
    );

    submit_accept_multi(&mut ring, listen_fd)?;
    submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
    ring.submit()?;
    if let Some(ready_tx) = runtime.ready_tx.take() {
        let _ = ready_tx.send(Ok(WorkerReady {
            provided_buffer_ring: false,
            recv_bundle: false,
            registered_send_buffer,
            zero_copy_send: use_zero_copy_send,
            zcrx_ready: true,
            zcrx_rx_buffer_size,
        }));
    }

    while !runtime.shutdown.load(Ordering::Acquire) {
        let mut queue_send_context = TcpQueueSendContext {
            fixed_send_pool: fixed_send_pool.as_mut(),
            send_options,
            send_queue_capacity: config.send_queue_capacity,
            stats: &runtime.stats,
        };
        drain_tcp_commands(
            &mut ring,
            &runtime.command_rx,
            &mut state,
            &mut event_emitter,
            &mut queue_send_context,
        )?;
        close_expired_half_closed_connections(
            &mut state,
            &mut event_emitter,
            fixed_send_pool.as_mut(),
            &runtime.stats,
        )?;
        close_idle_tcp_connections(
            &mut state,
            &mut event_emitter,
            fixed_send_pool.as_mut(),
            true,
            &runtime.stats,
            config.idle_timeout_ms,
        )?;
        event_emitter.flush()?;
        wait_for_completions(&ring)?;

        let completions: Vec<_> = ring.completion().collect();
        for cqe in completions {
            if cqe.flags() & IORING_CQE_F_SKIP != 0 {
                continue;
            }
            let (op, token) = unpack_user_data(cqe.user_data());
            match op {
                OP_ACCEPT => {
                    let mut accept_context = TcpZcrxAcceptContext {
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        zcrx_id: zcrx.zcrx_id,
                        buffer_size: zcrx_rx_buffer_size,
                        max_connections: config.max_connections,
                        tcp_no_delay: config.tcp_no_delay,
                        socket_recv_buffer_size: config.socket_recv_buffer_size,
                        socket_send_buffer_size: config.socket_send_buffer_size,
                        stats: &runtime.stats,
                    };
                    handle_tcp_zcrx_accept(
                        &mut ring,
                        listen_fd,
                        cqe.result(),
                        cqe.flags(),
                        &mut accept_context,
                    )?;
                }
                OP_RECV => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                        if cqe.result() > 0 {
                            if let Some(packet) = zcrx.decode_packet(&cqe)? {
                                zcrx.recycle_packet(packet)?;
                            }
                        }
                        continue;
                    };
                    let mut recv_context = TcpZcrxRecvContext {
                        zcrx: &mut zcrx,
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        buffer_size: zcrx_rx_buffer_size,
                        stats: &runtime.stats,
                    };
                    handle_tcp_zcrx_recv(&mut ring, fd, connection_id, &cqe, &mut recv_context)?;
                }
                OP_SEND => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                        continue;
                    };
                    let is_notification = cqueue::notif(cqe.flags());
                    let mut send_context = TcpSendContext {
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        stats: &runtime.stats,
                    };
                    handle_tcp_send(
                        &mut ring,
                        fd,
                        cqe.result(),
                        cqe.flags(),
                        is_notification,
                        &mut send_context,
                    )?;
                }
                OP_COMMAND => {
                    if cqe.result() < 0 {
                        let errno = -cqe.result();
                        if errno != libc::EINTR {
                            return Err(io::Error::from_raw_os_error(errno).into());
                        }
                    }
                    *command_counter = 0;
                    let mut queue_send_context = TcpQueueSendContext {
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        send_options,
                        send_queue_capacity: config.send_queue_capacity,
                        stats: &runtime.stats,
                    };
                    drain_tcp_commands(
                        &mut ring,
                        &runtime.command_rx,
                        &mut state,
                        &mut event_emitter,
                        &mut queue_send_context,
                    )?;
                    event_emitter.flush()?;
                    submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
                }
                _ => {}
            }
        }

        event_emitter.flush()?;
        ring.submit()?;
    }

    drain_tcp_shutdown_sends(
        &mut ring,
        &mut state,
        &mut event_emitter,
        fixed_send_pool.as_mut(),
        &runtime.stats,
    )?;
    event_emitter.flush()?;
    if registered_send_buffer {
        let _ = ring.submitter().unregister_buffers();
    }
    Ok(())
}

fn run_tcp_worker_inner(
    listen_fd: RawFd,
    command_event_fd: RawFd,
    config: TcpServerConfig,
    runtime: &mut TcpWorkerRuntime,
) -> Result<(), UringError> {
    if config.use_zero_copy_receive {
        return run_tcp_zcrx_worker_inner(listen_fd, command_event_fd, config, runtime);
    }

    let mut ring = IoUring::new(config.queue_depth)?;

    let mut probe = Probe::new();
    ring.submitter().register_probe(&mut probe)?;
    if !probe.is_supported(opcode::Accept::CODE) || !probe.is_supported(opcode::Recv::CODE) {
        return Err("kernel does not support accept/recv io_uring opcodes"
            .to_string()
            .into());
    }
    if !probe.is_supported(opcode::Send::CODE) || !probe.is_supported(opcode::Read::CODE) {
        return Err("kernel does not support send/read io_uring opcodes"
            .to_string()
            .into());
    }
    if config.use_zero_copy_send && !probe.is_supported(opcode::SendZc::CODE) {
        return Err(
            "zero-copy send requested but IORING_OP_SEND_ZC is unsupported"
                .to_string()
                .into(),
        );
    }
    let mut buffers = BufferPool::setup(
        &mut ring,
        config.buffer_count as u16,
        config.buffer_size as usize,
    )?;
    let provided_buffer_ring = buffers.provided_buffer_ring();
    let use_recv_bundle = resolve_recv_bundle(config.use_recv_bundle, &ring, provided_buffer_ring)?;
    let mut fixed_send_pool = setup_fixed_send_pool(&ring, &config)?;
    let registered_send_buffer = fixed_send_pool.is_some();
    let use_zero_copy_send = config.use_zero_copy_send;
    let use_registered_send_buffer = config.use_registered_send_buffer && registered_send_buffer;
    let send_options = TcpSendOptions {
        use_registered_send_buffer,
        use_zero_copy_send,
    };
    let mut command_counter = Box::new(0_u64);
    let mut state = TcpWorkerState::default();
    let mut event_emitter = TcpEventEmitter::new(
        std::mem::replace(&mut runtime.event_sink, TcpEventSink::None),
        Arc::clone(&runtime.stats),
        config.event_queue_capacity,
        config.event_batch_size,
    );

    submit_accept_multi(&mut ring, listen_fd)?;
    submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
    ring.submit()?;
    if let Some(ready_tx) = runtime.ready_tx.take() {
        let _ = ready_tx.send(Ok(WorkerReady {
            provided_buffer_ring,
            recv_bundle: use_recv_bundle,
            registered_send_buffer,
            zero_copy_send: use_zero_copy_send,
            zcrx_ready: false,
            zcrx_rx_buffer_size: 0,
        }));
    }

    while !runtime.shutdown.load(Ordering::Acquire) {
        let mut queue_send_context = TcpQueueSendContext {
            fixed_send_pool: fixed_send_pool.as_mut(),
            send_options,
            send_queue_capacity: config.send_queue_capacity,
            stats: &runtime.stats,
        };
        drain_tcp_commands(
            &mut ring,
            &runtime.command_rx,
            &mut state,
            &mut event_emitter,
            &mut queue_send_context,
        )?;
        close_expired_half_closed_connections(
            &mut state,
            &mut event_emitter,
            fixed_send_pool.as_mut(),
            &runtime.stats,
        )?;
        close_idle_tcp_connections(
            &mut state,
            &mut event_emitter,
            fixed_send_pool.as_mut(),
            true,
            &runtime.stats,
            config.idle_timeout_ms,
        )?;
        event_emitter.flush()?;
        wait_for_completions(&ring)?;

        let completions: Vec<_> = ring
            .completion()
            .map(|cqe| (cqe.user_data(), cqe.result(), cqe.flags()))
            .collect();

        for (user_data, result, flags) in completions {
            let (op, token) = unpack_user_data(user_data);
            match op {
                OP_ACCEPT => {
                    let mut accept_context = TcpAcceptContext {
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        buffer_size: config.buffer_size,
                        use_recv_bundle,
                        max_connections: config.max_connections,
                        tcp_no_delay: config.tcp_no_delay,
                        socket_recv_buffer_size: config.socket_recv_buffer_size,
                        socket_send_buffer_size: config.socket_send_buffer_size,
                        stats: &runtime.stats,
                    };
                    handle_tcp_accept(&mut ring, listen_fd, result, flags, &mut accept_context)?;
                }
                OP_RECV => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                        if result > 0 {
                            if let Some(bid) = cqueue::buffer_select(flags) {
                                buffers.discard_recv(
                                    &mut ring,
                                    bid,
                                    result as usize,
                                    use_recv_bundle,
                                    &runtime.stats,
                                )?;
                            }
                        }
                        continue;
                    };
                    let mut recv_context = TcpRecvContext {
                        buffers: &mut buffers,
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        buffer_size: config.buffer_size,
                        stats: &runtime.stats,
                        use_recv_bundle,
                    };
                    handle_tcp_recv(
                        &mut ring,
                        fd,
                        connection_id,
                        result,
                        flags,
                        &mut recv_context,
                    )?;
                }
                OP_SEND => {
                    let connection_id = unpack_connection_id(token);
                    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                        continue;
                    };
                    let is_notification = cqueue::notif(flags);
                    let mut send_context = TcpSendContext {
                        state: &mut state,
                        event_emitter: &mut event_emitter,
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        stats: &runtime.stats,
                    };
                    handle_tcp_send(
                        &mut ring,
                        fd,
                        result,
                        flags,
                        is_notification,
                        &mut send_context,
                    )?;
                }
                OP_COMMAND => {
                    if result < 0 {
                        let errno = -result;
                        if errno != libc::EINTR {
                            return Err(io::Error::from_raw_os_error(errno).into());
                        }
                    }
                    *command_counter = 0;
                    let mut queue_send_context = TcpQueueSendContext {
                        fixed_send_pool: fixed_send_pool.as_mut(),
                        send_options,
                        send_queue_capacity: config.send_queue_capacity,
                        stats: &runtime.stats,
                    };
                    drain_tcp_commands(
                        &mut ring,
                        &runtime.command_rx,
                        &mut state,
                        &mut event_emitter,
                        &mut queue_send_context,
                    )?;
                    event_emitter.flush()?;
                    submit_command_read(&mut ring, command_event_fd, command_counter.as_mut())?;
                }
                OP_PROVIDE if result < 0 => {
                    return Err(io::Error::from_raw_os_error(-result).into());
                }
                _ => {}
            }
        }

        event_emitter.flush()?;
        ring.submit()?;
    }

    drain_tcp_shutdown_sends(
        &mut ring,
        &mut state,
        &mut event_emitter,
        fixed_send_pool.as_mut(),
        &runtime.stats,
    )?;
    event_emitter.flush()?;
    if registered_send_buffer {
        let _ = ring.submitter().unregister_buffers();
    }
    buffers.unregister(&ring);
    Ok(())
}

fn drain_tcp_commands<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    command_rx: &Receiver<TcpCommand>,
    state: &mut TcpWorkerState,
    event_emitter: &mut TcpEventEmitter,
    send_context: &mut TcpQueueSendContext<'_>,
) -> Result<(), UringError> {
    loop {
        match command_rx.try_recv() {
            Ok(TcpCommand::Send {
                connection_id,
                data,
            }) => {
                queue_tcp_command_send(ring, state, connection_id, data, send_context)?;
            }
            Ok(TcpCommand::SendBatch { sends }) => {
                for send in sends {
                    queue_tcp_command_send(
                        ring,
                        state,
                        send.connection_id,
                        send.data,
                        send_context,
                    )?;
                }
            }
            Ok(TcpCommand::SendAndClose {
                connection_id,
                data,
            }) => {
                queue_tcp_command_send(ring, state, connection_id, data, send_context)?;
                close_tcp_connection_after_send_by_id(
                    connection_id,
                    state,
                    event_emitter,
                    send_context.fixed_send_pool.as_deref_mut(),
                    send_context.stats,
                )?;
            }
            Ok(TcpCommand::SendBatchAndClose { sends }) => {
                let mut close_ids = Vec::with_capacity(sends.len());
                for send in sends {
                    close_ids.push(send.connection_id);
                    queue_tcp_command_send(
                        ring,
                        state,
                        send.connection_id,
                        send.data,
                        send_context,
                    )?;
                }
                for connection_id in close_ids {
                    close_tcp_connection_after_send_by_id(
                        connection_id,
                        state,
                        event_emitter,
                        send_context.fixed_send_pool.as_deref_mut(),
                        send_context.stats,
                    )?;
                }
            }
            Ok(TcpCommand::Close { connection_id }) => {
                if let Some(&fd) = state.id_to_fd.get(&connection_id) {
                    close_tcp_connection(
                        fd,
                        state,
                        event_emitter,
                        true,
                        send_context.fixed_send_pool.as_deref_mut(),
                        send_context.stats,
                    )?;
                }
            }
            Err(TryRecvError::Empty) => return Ok(()),
            Err(TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

fn queue_tcp_command_send<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    state: &mut TcpWorkerState,
    connection_id: u32,
    data: Vec<u8>,
    send_context: &mut TcpQueueSendContext<'_>,
) -> Result<bool, UringError> {
    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
        return Ok(false);
    };
    let Some(connection) = state.connections.get_mut(&fd) else {
        return Ok(false);
    };
    connection.data_event_pending = false;
    connection.half_close_grace_ticks = 0;
    connection.last_activity = Instant::now();
    queue_tcp_send(ring, fd, connection, data, send_context)
}

fn close_tcp_connection_after_send_by_id(
    connection_id: u32,
    state: &mut TcpWorkerState,
    event_emitter: &mut TcpEventEmitter,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    let Some(&fd) = state.id_to_fd.get(&connection_id) else {
        return Ok(());
    };
    close_tcp_connection_after_send(fd, state, event_emitter, fixed_send_pool, stats)
}

fn close_tcp_connection_after_send(
    fd: RawFd,
    state: &mut TcpWorkerState,
    event_emitter: &mut TcpEventEmitter,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    let Some(connection) = state.connections.get_mut(&fd) else {
        return Ok(());
    };
    if connection.active_send.is_some() || !connection.send_queue.is_empty() {
        connection.close_after_send = true;
        return Ok(());
    }
    close_tcp_connection(fd, state, event_emitter, true, fixed_send_pool, stats)
}

fn defer_tcp_recv_shutdown(fd: RawFd, state: &mut TcpWorkerState) -> bool {
    let Some(connection) = state.connections.get_mut(&fd) else {
        return false;
    };
    connection.recv_active = false;
    if connection.data_event_pending {
        connection.close_after_send = true;
        connection.half_close_grace_ticks = HALF_CLOSE_RESPONSE_GRACE_TICKS;
        return true;
    }
    if connection.active_send.is_some() || !connection.send_queue.is_empty() {
        connection.close_after_send = true;
        return true;
    }
    false
}

fn close_expired_half_closed_connections(
    state: &mut TcpWorkerState,
    event_emitter: &mut TcpEventEmitter,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    let mut fixed_send_pool = fixed_send_pool;
    let mut expired = Vec::new();
    for (&fd, connection) in &mut state.connections {
        if connection.half_close_grace_ticks == 0
            || connection.active_send.is_some()
            || !connection.send_queue.is_empty()
        {
            continue;
        }
        connection.half_close_grace_ticks -= 1;
        if connection.half_close_grace_ticks == 0 {
            expired.push(fd);
        }
    }

    for fd in expired {
        close_tcp_connection(
            fd,
            state,
            event_emitter,
            true,
            fixed_send_pool.as_deref_mut(),
            stats,
        )?;
    }
    Ok(())
}

fn idle_timeout_duration(idle_timeout_ms: u32) -> Option<Duration> {
    if idle_timeout_ms == 0 {
        None
    } else {
        Some(Duration::from_millis(idle_timeout_ms as u64))
    }
}

fn close_idle_connections(
    connections: &mut HashMap<RawFd, Connection>,
    id_to_fd: &mut HashMap<u32, RawFd>,
    stats: &TransportStats,
    idle_timeout_ms: u32,
) {
    let Some(timeout) = idle_timeout_duration(idle_timeout_ms) else {
        return;
    };
    let now = Instant::now();
    let expired = connections
        .iter()
        .filter(|(_, connection)| {
            !connection.send_started && now.duration_since(connection.last_activity) >= timeout
        })
        .map(|(&fd, _)| fd)
        .collect::<Vec<_>>();

    for fd in expired {
        stats.record_idle_timeout();
        close_connection(fd, connections, id_to_fd, stats);
    }
}

fn close_idle_tcp_connections(
    state: &mut TcpWorkerState,
    event_emitter: &mut TcpEventEmitter,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
    emit_close: bool,
    stats: &TransportStats,
    idle_timeout_ms: u32,
) -> Result<(), UringError> {
    let Some(timeout) = idle_timeout_duration(idle_timeout_ms) else {
        return Ok(());
    };
    let now = Instant::now();
    let expired = state
        .connections
        .iter()
        .filter(|(_, connection)| {
            connection.active_send.is_none()
                && connection.send_queue.is_empty()
                && now.duration_since(connection.last_activity) >= timeout
        })
        .map(|(&fd, _)| fd)
        .collect::<Vec<_>>();

    let mut fixed_send_pool = fixed_send_pool;
    for fd in expired {
        stats.record_idle_timeout();
        close_tcp_connection(
            fd,
            state,
            event_emitter,
            emit_close,
            fixed_send_pool.as_deref_mut(),
            stats,
        )?;
    }
    Ok(())
}

fn mark_connection_activity(connections: &mut HashMap<RawFd, Connection>, fd: RawFd) {
    if let Some(connection) = connections.get_mut(&fd) {
        connection.last_activity = Instant::now();
    }
}

fn mark_tcp_connection_activity(state: &mut TcpWorkerState, fd: RawFd) {
    if let Some(connection) = state.connections.get_mut(&fd) {
        connection.last_activity = Instant::now();
    }
}

fn drain_tcp_shutdown_sends<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    state: &mut TcpWorkerState,
    event_emitter: &mut TcpEventEmitter,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    let mut fixed_send_pool = fixed_send_pool;
    for fd in state.connections.keys().copied().collect::<Vec<_>>() {
        close_tcp_connection(
            fd,
            state,
            event_emitter,
            false,
            fixed_send_pool.as_deref_mut(),
            stats,
        )?;
    }

    for _ in 0..SHUTDOWN_SEND_DRAIN_TICKS {
        if state.connections.is_empty()
            || !state
                .connections
                .values()
                .any(|connection| connection.active_send.is_some())
        {
            break;
        }

        wait_for_completions(ring)?;
        let completions: Vec<_> = ring
            .completion()
            .map(|cqe| {
                let cqe: cqueue::Entry = cqe.into();
                (cqe.user_data(), cqe.result(), cqe.flags())
            })
            .collect();
        for (user_data, result, flags) in completions {
            let (op, token) = unpack_user_data(user_data);
            if op != OP_SEND {
                continue;
            }
            let connection_id = unpack_connection_id(token);
            let Some(&fd) = state.id_to_fd.get(&connection_id) else {
                continue;
            };
            let mut send_context = TcpSendContext {
                state,
                event_emitter,
                fixed_send_pool: fixed_send_pool.as_deref_mut(),
                stats,
            };
            handle_tcp_send(
                ring,
                fd,
                result,
                flags,
                cqueue::notif(flags),
                &mut send_context,
            )?;
        }

        for fd in state.connections.keys().copied().collect::<Vec<_>>() {
            close_tcp_connection(
                fd,
                state,
                event_emitter,
                false,
                fixed_send_pool.as_deref_mut(),
                stats,
            )?;
        }
    }

    for fd in state.connections.keys().copied().collect::<Vec<_>>() {
        force_close_tcp_connection(
            fd,
            state,
            event_emitter,
            false,
            fixed_send_pool.as_deref_mut(),
            stats,
        )?;
    }
    Ok(())
}

fn handle_tcp_accept<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    listen_fd: RawFd,
    result: i32,
    flags: u32,
    context: &mut TcpAcceptContext<'_>,
) -> Result<(), UringError> {
    if result >= 0 {
        let fd = result;
        if connection_limit_reached(context.state.connections.len(), context.max_connections) {
            reject_connection(fd, context.stats);
        } else {
            configure_accepted_socket(
                fd,
                context.tcp_no_delay,
                context.socket_recv_buffer_size,
                context.socket_send_buffer_size,
            );
            let connection_id = context.state.next_connection_id;
            context.state.next_connection_id =
                context.state.next_connection_id.wrapping_add(1).max(1);
            context.state.connections.insert(
                fd,
                TcpConnection {
                    id: connection_id,
                    recv_active: true,
                    close_after_send: false,
                    data_event_pending: false,
                    half_close_grace_ticks: 0,
                    send_queue: VecDeque::new(),
                    active_send: None,
                    last_activity: Instant::now(),
                },
            );
            context.state.id_to_fd.insert(connection_id, fd);
            context.stats.record_connection_open();
            let (remote_addr, remote_address, remote_family, remote_port) = peer_event_fields(fd);
            context.event_emitter.emit(TcpEvent {
                event_type: "connect".to_string(),
                connection_id,
                remote_addr,
                remote_address,
                remote_family,
                remote_port,
                data: None,
            })?;
            submit_tcp_recv_multi(
                ring,
                fd,
                connection_id,
                context.buffer_size,
                context.use_recv_bundle,
            )?;
        }
    }

    if !cqueue::more(flags) {
        submit_accept_multi(ring, listen_fd)?;
    }
    Ok(())
}

fn handle_tcp_zcrx_accept(
    ring: &mut ZcrxRing,
    listen_fd: RawFd,
    result: i32,
    flags: u32,
    context: &mut TcpZcrxAcceptContext<'_>,
) -> Result<(), UringError> {
    if result >= 0 {
        let fd = result;
        if connection_limit_reached(context.state.connections.len(), context.max_connections) {
            reject_connection(fd, context.stats);
        } else {
            configure_accepted_socket(
                fd,
                context.tcp_no_delay,
                context.socket_recv_buffer_size,
                context.socket_send_buffer_size,
            );
            let connection_id = context.state.next_connection_id;
            context.state.next_connection_id =
                context.state.next_connection_id.wrapping_add(1).max(1);
            context.state.connections.insert(
                fd,
                TcpConnection {
                    id: connection_id,
                    recv_active: true,
                    close_after_send: false,
                    data_event_pending: false,
                    half_close_grace_ticks: 0,
                    send_queue: VecDeque::new(),
                    active_send: None,
                    last_activity: Instant::now(),
                },
            );
            context.state.id_to_fd.insert(connection_id, fd);
            context.stats.record_connection_open();
            let (remote_addr, remote_address, remote_family, remote_port) = peer_event_fields(fd);
            context.event_emitter.emit(TcpEvent {
                event_type: "connect".to_string(),
                connection_id,
                remote_addr,
                remote_address,
                remote_family,
                remote_port,
                data: None,
            })?;
            submit_zcrx_recv_multi(
                ring,
                fd,
                connection_id,
                context.zcrx_id,
                context.buffer_size,
            )?;
        }
    }

    if !cqueue::more(flags) {
        submit_accept_multi(ring, listen_fd)?;
    }
    Ok(())
}

fn handle_tcp_echo_recv<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    result: i32,
    flags: u32,
    context: &mut TcpEchoRecvContext<'_>,
) -> Result<(), UringError> {
    let Some(connection) = context.state.connections.get(&fd) else {
        if result > 0 {
            if let Some(bid) = cqueue::buffer_select(flags) {
                context.buffers.discard_recv(
                    ring,
                    bid,
                    result as usize,
                    context.use_recv_bundle,
                    context.stats,
                )?;
            }
        }
        return Ok(());
    };
    if connection.id != connection_id {
        if result > 0 {
            if let Some(bid) = cqueue::buffer_select(flags) {
                context.buffers.discard_recv(
                    ring,
                    bid,
                    result as usize,
                    context.use_recv_bundle,
                    context.stats,
                )?;
            }
        }
        return Ok(());
    }

    if result == -libc::ENOBUFS {
        if !connection.close_after_send {
            recover_recv_buffer_starvation(
                ring,
                fd,
                connection_id,
                context.buffer_size,
                context.use_recv_bundle,
                context.stats,
            )?;
        }
        return Ok(());
    }

    if result <= 0 {
        if defer_tcp_recv_shutdown(fd, context.state) {
            return Ok(());
        }
        close_tcp_connection(
            fd,
            context.state,
            context.event_emitter,
            false,
            context.fixed_send_pool.as_deref_mut(),
            context.stats,
        )?;
        return Ok(());
    }

    mark_tcp_connection_activity(context.state, fd);
    if let Some(bid) = cqueue::buffer_select(flags) {
        let data = context.buffers.consume_recv(
            ring,
            bid,
            result as usize,
            context.use_recv_bundle,
            context.stats,
        )?;
        context.stats.record_bytes_received(data.len());
        if let Some(connection) = context.state.connections.get_mut(&fd) {
            let mut send_context = TcpQueueSendContext {
                fixed_send_pool: context.fixed_send_pool.as_deref_mut(),
                send_options: TcpSendOptions {
                    use_registered_send_buffer: context.use_registered_send_buffer,
                    use_zero_copy_send: context.use_zero_copy_send,
                },
                send_queue_capacity: context.send_queue_capacity,
                stats: context.stats,
            };
            queue_tcp_send(ring, fd, connection, data, &mut send_context)?;
            connection.close_after_send = true;
        }
    }

    if !cqueue::more(flags) {
        if let Some(connection) = context.state.connections.get(&fd) {
            if !connection.close_after_send {
                resubmit_tcp_recv_multi(
                    ring,
                    fd,
                    connection_id,
                    context.buffer_size,
                    context.use_recv_bundle,
                    context.stats,
                )?;
            }
        }
    }
    Ok(())
}

fn handle_tcp_zcrx_recv(
    ring: &mut ZcrxRing,
    fd: RawFd,
    connection_id: u32,
    cqe: &cqueue::Entry32,
    context: &mut TcpZcrxRecvContext<'_>,
) -> Result<(), UringError> {
    let Some(connection) = context.state.connections.get(&fd) else {
        if cqe.result() > 0 {
            if let Some(packet) = context.zcrx.decode_packet(cqe)? {
                context.zcrx.recycle_packet(packet)?;
            }
        }
        return Ok(());
    };
    if connection.id != connection_id {
        if cqe.result() > 0 {
            if let Some(packet) = context.zcrx.decode_packet(cqe)? {
                context.zcrx.recycle_packet(packet)?;
            }
        }
        return Ok(());
    }

    if cqe.result() <= 0 {
        if defer_tcp_recv_shutdown(fd, context.state) {
            return Ok(());
        }
        close_tcp_connection(
            fd,
            context.state,
            context.event_emitter,
            true,
            context.fixed_send_pool.as_deref_mut(),
            context.stats,
        )?;
        return Ok(());
    }

    let packet = match context.zcrx.decode_packet(cqe)? {
        Some(packet) => packet,
        None => {
            close_tcp_connection(
                fd,
                context.state,
                context.event_emitter,
                true,
                context.fixed_send_pool.as_deref_mut(),
                context.stats,
            )?;
            return Ok(());
        }
    };
    let data = context.zcrx.packet_bytes(packet).to_vec();
    context.zcrx.recycle_packet(packet)?;
    context.stats.record_recv_copy(data.len());
    context.stats.record_zcrx_packet(data.len());
    context.stats.record_bytes_received(data.len());
    mark_tcp_connection_activity(context.state, fd);
    context.event_emitter.emit(TcpEvent {
        event_type: "data".to_string(),
        connection_id,
        remote_addr: None,
        remote_address: None,
        remote_family: None,
        remote_port: None,
        data: Some(Buffer::from(data)),
    })?;
    if let Some(connection) = context.state.connections.get_mut(&fd) {
        connection.data_event_pending = true;
    }

    if !cqueue::more(cqe.flags()) {
        if let Some(connection) = context.state.connections.get_mut(&fd) {
            connection.recv_active = false;
        }
        submit_zcrx_recv_multi(
            ring,
            fd,
            connection_id,
            context.zcrx.zcrx_id,
            context.buffer_size,
        )?;
        if let Some(connection) = context.state.connections.get_mut(&fd) {
            connection.recv_active = true;
        }
    }
    Ok(())
}

fn handle_tcp_echo_zcrx_recv(
    ring: &mut ZcrxRing,
    fd: RawFd,
    connection_id: u32,
    cqe: &cqueue::Entry32,
    context: &mut TcpZcrxEchoRecvContext<'_>,
) -> Result<(), UringError> {
    let Some(connection) = context.state.connections.get(&fd) else {
        if cqe.result() > 0 {
            if let Some(packet) = context.zcrx.decode_packet(cqe)? {
                context.zcrx.recycle_packet(packet)?;
            }
        }
        return Ok(());
    };
    if connection.id != connection_id {
        if cqe.result() > 0 {
            if let Some(packet) = context.zcrx.decode_packet(cqe)? {
                context.zcrx.recycle_packet(packet)?;
            }
        }
        return Ok(());
    }

    if cqe.result() <= 0 {
        if defer_tcp_recv_shutdown(fd, context.state) {
            return Ok(());
        }
        close_tcp_connection(
            fd,
            context.state,
            context.event_emitter,
            false,
            context.fixed_send_pool.as_deref_mut(),
            context.stats,
        )?;
        return Ok(());
    }

    let packet = match context.zcrx.decode_packet(cqe)? {
        Some(packet) => packet,
        None => {
            close_tcp_connection(
                fd,
                context.state,
                context.event_emitter,
                false,
                context.fixed_send_pool.as_deref_mut(),
                context.stats,
            )?;
            return Ok(());
        }
    };
    let data = context.zcrx.packet_bytes(packet).to_vec();
    context.zcrx.recycle_packet(packet)?;
    context.stats.record_recv_copy(data.len());
    context.stats.record_zcrx_packet(data.len());
    context.stats.record_bytes_received(data.len());
    mark_tcp_connection_activity(context.state, fd);

    if let Some(connection) = context.state.connections.get_mut(&fd) {
        let mut send_context = TcpQueueSendContext {
            fixed_send_pool: context.fixed_send_pool.as_deref_mut(),
            send_options: TcpSendOptions {
                use_registered_send_buffer: context.use_registered_send_buffer,
                use_zero_copy_send: context.use_zero_copy_send,
            },
            send_queue_capacity: context.send_queue_capacity,
            stats: context.stats,
        };
        queue_tcp_send(ring, fd, connection, data, &mut send_context)?;
        connection.close_after_send = true;
    }

    if !cqueue::more(cqe.flags()) {
        if let Some(connection) = context.state.connections.get(&fd) {
            if !connection.close_after_send {
                submit_zcrx_recv_multi(
                    ring,
                    fd,
                    connection_id,
                    context.zcrx.zcrx_id,
                    context.buffer_size,
                )?;
            }
        }
    }
    Ok(())
}

fn handle_tcp_recv<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    result: i32,
    flags: u32,
    context: &mut TcpRecvContext<'_>,
) -> Result<(), UringError> {
    let Some(connection) = context.state.connections.get(&fd) else {
        if result > 0 {
            if let Some(bid) = cqueue::buffer_select(flags) {
                context.buffers.discard_recv(
                    ring,
                    bid,
                    result as usize,
                    context.use_recv_bundle,
                    context.stats,
                )?;
            }
        }
        return Ok(());
    };
    if connection.id != connection_id {
        if result > 0 {
            if let Some(bid) = cqueue::buffer_select(flags) {
                context.buffers.discard_recv(
                    ring,
                    bid,
                    result as usize,
                    context.use_recv_bundle,
                    context.stats,
                )?;
            }
        }
        return Ok(());
    }

    if result == -libc::ENOBUFS {
        if !connection.close_after_send {
            recover_recv_buffer_starvation(
                ring,
                fd,
                connection_id,
                context.buffer_size,
                context.use_recv_bundle,
                context.stats,
            )?;
        }
        return Ok(());
    }

    if result <= 0 {
        if defer_tcp_recv_shutdown(fd, context.state) {
            return Ok(());
        }
        close_tcp_connection(
            fd,
            context.state,
            context.event_emitter,
            true,
            context.fixed_send_pool.as_deref_mut(),
            context.stats,
        )?;
        return Ok(());
    }

    mark_tcp_connection_activity(context.state, fd);
    if let Some(bid) = cqueue::buffer_select(flags) {
        let data = context.buffers.consume_recv(
            ring,
            bid,
            result as usize,
            context.use_recv_bundle,
            context.stats,
        )?;
        context.stats.record_bytes_received(data.len());
        context.event_emitter.emit(TcpEvent {
            event_type: "data".to_string(),
            connection_id,
            remote_addr: None,
            remote_address: None,
            remote_family: None,
            remote_port: None,
            data: Some(Buffer::from(data)),
        })?;
        if let Some(connection) = context.state.connections.get_mut(&fd) {
            connection.data_event_pending = true;
        }
    }

    if !cqueue::more(flags) {
        if let Some(connection) = context.state.connections.get_mut(&fd) {
            connection.recv_active = false;
        }
        resubmit_tcp_recv_multi(
            ring,
            fd,
            connection_id,
            context.buffer_size,
            context.use_recv_bundle,
            context.stats,
        )?;
        if let Some(connection) = context.state.connections.get_mut(&fd) {
            connection.recv_active = true;
        }
    }
    Ok(())
}

fn handle_tcp_send<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    result: i32,
    flags: u32,
    is_notification: bool,
    context: &mut TcpSendContext<'_>,
) -> Result<(), UringError> {
    let mut should_close = false;

    {
        let Some(connection) = context.state.connections.get_mut(&fd) else {
            return Ok(());
        };

        if is_notification {
            context.stats.record_zero_copy_send_notification(result);
            let Some(active_send) = connection.active_send.as_mut() else {
                return Ok(());
            };
            if !active_send.waiting_notification {
                return Ok(());
            }
            active_send.waiting_notification = false;
            let notification_result = active_send.notification_result;
            should_close = finish_tcp_send_completion(
                ring,
                fd,
                connection,
                notification_result,
                context.fixed_send_pool.as_deref_mut(),
                context.stats,
            )?;
        } else {
            if let Some(active_send) = connection.active_send.as_mut() {
                if active_send.use_zero_copy && cqueue::more(flags) {
                    active_send.waiting_notification = true;
                    active_send.notification_result = result;
                    return Ok(());
                }

                should_close = finish_tcp_send_completion(
                    ring,
                    fd,
                    connection,
                    result,
                    context.fixed_send_pool.as_deref_mut(),
                    context.stats,
                )?;
            } else {
                if result <= 0 {
                    connection.close_after_send = true;
                    should_close = true;
                }
            }
        };
    }

    if should_close {
        close_tcp_connection(
            fd,
            context.state,
            context.event_emitter,
            true,
            context.fixed_send_pool.as_deref_mut(),
            context.stats,
        )?;
    }
    Ok(())
}

fn finish_tcp_send_completion<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection: &mut TcpConnection,
    result: i32,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
    stats: &TransportStats,
) -> Result<bool, UringError> {
    let mut fixed_send_pool = fixed_send_pool;
    let Some(active_send) = connection.active_send.as_mut() else {
        return Ok(connection.close_after_send);
    };

    if result < 0 && active_send.use_zero_copy {
        stats.record_zero_copy_send_error();
        active_send.use_zero_copy = false;
        active_send.waiting_notification = false;
        submit_tcp_send(
            ring,
            fd,
            connection.id,
            active_send,
            fixed_send_pool.as_deref(),
            stats,
        )?;
        return Ok(false);
    }

    if result < 0 && active_send.slot().is_some() {
        stats.record_registered_send_error();
        let Some(slot) = active_send.slot() else {
            unreachable!();
        };
        let len = active_send.len();
        let offset = active_send.offset;
        let Some(pool) = fixed_send_pool.as_deref_mut() else {
            return Err("fixed send buffer pool disappeared".to_string().into());
        };
        let data = pool.copy_slot(slot, len);
        pool.release(slot);
        active_send.data = TcpSendData::Heap(data);
        active_send.offset = offset;
        active_send.waiting_notification = false;
        submit_tcp_send(ring, fd, connection.id, active_send, None, stats)?;
        return Ok(false);
    }

    if result <= 0 {
        connection.close_after_send = true;
    } else {
        let bytes_sent = result as usize;
        stats.record_bytes_sent(bytes_sent);
        connection.last_activity = Instant::now();
        active_send.offset += bytes_sent;
    }

    if active_send.offset < active_send.len() && !connection.close_after_send {
        submit_tcp_send(
            ring,
            fd,
            connection.id,
            active_send,
            fixed_send_pool.as_deref(),
            stats,
        )?;
        return Ok(false);
    }

    release_tcp_send(
        connection.active_send.take(),
        fixed_send_pool.as_deref_mut(),
    );

    connection.active_send = connection.send_queue.pop_front();
    if let Some(next_send) = connection.active_send.as_ref() {
        submit_tcp_send(
            ring,
            fd,
            connection.id,
            next_send,
            fixed_send_pool.as_deref(),
            stats,
        )?;
        return Ok(false);
    }

    if connection.close_after_send {
        return Ok(true);
    }
    Ok(false)
}

fn queue_tcp_send<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection: &mut TcpConnection,
    data: Vec<u8>,
    context: &mut TcpQueueSendContext<'_>,
) -> Result<bool, UringError> {
    if data.is_empty() {
        return Ok(true);
    }

    if connection.active_send.is_some()
        && connection.send_queue.len() >= context.send_queue_capacity as usize
    {
        context.stats.record_send_queue_drop();
        return Ok(false);
    }

    let use_fixed_send_buffer =
        context.send_options.use_zero_copy_send || context.send_options.use_registered_send_buffer;
    let data = if use_fixed_send_buffer {
        let data_len = data.len();
        match context
            .fixed_send_pool
            .as_deref_mut()
            .and_then(|pool| pool.alloc(&data))
        {
            Some(slot) => TcpSendData::Fixed {
                slot,
                len: data_len,
            },
            None => {
                context.stats.record_fixed_send_buffer_miss(data_len);
                TcpSendData::Heap(Arc::<[u8]>::from(data))
            }
        }
    } else {
        TcpSendData::Heap(Arc::<[u8]>::from(data))
    };
    let use_zero_copy = context.send_options.use_zero_copy_send;

    let pending = TcpPendingSend {
        data,
        offset: 0,
        use_zero_copy,
        waiting_notification: false,
        notification_result: 0,
    };
    if connection.active_send.is_none() {
        connection.active_send = Some(pending);
        if let Some(active_send) = connection.active_send.as_ref() {
            submit_tcp_send(
                ring,
                fd,
                connection.id,
                active_send,
                context.fixed_send_pool.as_deref(),
                context.stats,
            )?;
        }
    } else {
        connection.send_queue.push_back(pending);
    }
    Ok(true)
}

fn submit_tcp_send<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    pending: &TcpPendingSend,
    fixed_send_pool: Option<&FixedSendBufferPool>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    let remaining = pending.len() - pending.offset;
    let entry = match &pending.data {
        TcpSendData::Heap(data) => {
            // SAFETY: pending.offset is maintained below pending.len(), and
            // pending.len() was derived from this Arc<[u8]> payload length.
            let ptr = unsafe { data.as_ptr().add(pending.offset) };
            if pending.use_zero_copy {
                stats.record_zero_copy_send_request();
                opcode::SendZc::new(types::Fd(fd), ptr, remaining as u32)
                    .flags(libc::MSG_NOSIGNAL)
                    .zc_flags(SEND_ZC_REPORT_USAGE)
                    .build()
                    .user_data(pack_connection_user_data(OP_SEND, connection_id))
            } else {
                opcode::Send::new(types::Fd(fd), ptr, remaining as u32)
                    .flags(libc::MSG_NOSIGNAL)
                    .build()
                    .user_data(pack_connection_user_data(OP_SEND, connection_id))
            }
        }
        TcpSendData::Fixed { slot, .. } => {
            let Some(pool) = fixed_send_pool else {
                return Err("fixed send buffer pool disappeared".to_string().into());
            };
            let ptr = pool.ptr(*slot, pending.offset);
            stats.record_registered_send_request();
            if pending.use_zero_copy {
                stats.record_zero_copy_send_request();
                opcode::SendZc::new(types::Fd(fd), ptr, remaining as u32)
                    .flags(libc::MSG_NOSIGNAL)
                    .buf_index(Some(*slot))
                    .zc_flags(SEND_ZC_REPORT_USAGE)
                    .build()
                    .user_data(pack_connection_user_data(OP_SEND, connection_id))
            } else {
                let mut entry = opcode::Send::new(types::Fd(fd), ptr, remaining as u32)
                    .flags(libc::MSG_NOSIGNAL)
                    .build();
                set_send_fixed_buffer(&mut entry, *slot);
                entry.user_data(pack_connection_user_data(OP_SEND, connection_id))
            }
        }
    };
    push_entry(ring, entry)
}

fn set_send_fixed_buffer(entry: &mut squeue::Entry, buf_index: u16) {
    // SAFETY: SqeFixedBufferPrefix mirrors the kernel SQE prefix up through
    // buf_index; io_uring's squeue::Entry has that layout for send SQEs.
    let sqe = unsafe { &mut *(entry as *mut squeue::Entry).cast::<SqeFixedBufferPrefix>() };
    sqe.ioprio |= RECVSEND_FIXED_BUF;
    sqe.buf_index = buf_index;
}

fn submit_command_read<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    command_event_fd: RawFd,
    command_counter: &mut u64,
) -> Result<(), UringError> {
    let entry = opcode::Read::new(
        types::Fd(command_event_fd),
        (command_counter as *mut u64).cast::<u8>(),
        std::mem::size_of::<u64>() as u32,
    )
    .build()
    .user_data(pack_user_data(OP_COMMAND, command_event_fd));
    push_entry(ring, entry)
}

fn handle_command_completion(result: i32) -> Result<(), UringError> {
    if result < 0 {
        let errno = -result;
        if errno != libc::EINTR {
            return Err(io::Error::from_raw_os_error(errno).into());
        }
    }
    Ok(())
}

fn close_tcp_connection(
    fd: RawFd,
    state: &mut TcpWorkerState,
    event_emitter: &mut TcpEventEmitter,
    emit_close: bool,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    let mut fixed_send_pool = fixed_send_pool;
    let Some(connection) = state.connections.get_mut(&fd) else {
        return Ok(());
    };
    if connection.active_send.is_some() {
        connection.close_after_send = true;
        return Ok(());
    }

    let Some(mut connection) = state.connections.remove(&fd) else {
        return Ok(());
    };
    state.id_to_fd.remove(&connection.id);
    release_tcp_send(
        connection.active_send.take(),
        fixed_send_pool.as_deref_mut(),
    );
    while let Some(pending_send) = connection.send_queue.pop_front() {
        release_tcp_send(Some(pending_send), fixed_send_pool.as_deref_mut());
    }
    close_fd(fd);
    stats.record_connection_close();
    if emit_close {
        event_emitter.emit(TcpEvent {
            event_type: "close".to_string(),
            connection_id: connection.id,
            remote_addr: None,
            remote_address: None,
            remote_family: None,
            remote_port: None,
            data: None,
        })?;
    }
    Ok(())
}

fn force_close_tcp_connection(
    fd: RawFd,
    state: &mut TcpWorkerState,
    event_emitter: &mut TcpEventEmitter,
    emit_close: bool,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
    stats: &TransportStats,
) -> Result<(), UringError> {
    let mut fixed_send_pool = fixed_send_pool;
    let Some(mut connection) = state.connections.remove(&fd) else {
        return Ok(());
    };
    state.id_to_fd.remove(&connection.id);
    release_tcp_send(
        connection.active_send.take(),
        fixed_send_pool.as_deref_mut(),
    );
    while let Some(pending_send) = connection.send_queue.pop_front() {
        release_tcp_send(Some(pending_send), fixed_send_pool.as_deref_mut());
    }
    close_fd(fd);
    stats.record_connection_close();
    if emit_close {
        event_emitter.emit(TcpEvent {
            event_type: "close".to_string(),
            connection_id: connection.id,
            remote_addr: None,
            remote_address: None,
            remote_family: None,
            remote_port: None,
            data: None,
        })?;
    }
    Ok(())
}

fn release_tcp_send(
    send: Option<TcpPendingSend>,
    fixed_send_pool: Option<&mut FixedSendBufferPool>,
) {
    let Some(send) = send else {
        return;
    };
    let Some(slot) = send.slot() else {
        return;
    };
    if let Some(pool) = fixed_send_pool {
        pool.release(slot);
    }
}

fn emit_tcp_event(
    event_callback: &TcpEventCallback,
    event: TcpEvent,
    stats: Arc<TransportStats>,
    event_queue_capacity: u32,
) -> Result<(), UringError> {
    if !stats.try_acquire_event_queue_slots(1, event_queue_capacity) {
        stats.record_event_queue_drop(1);
        return Ok(());
    }
    let callback_stats = Arc::clone(&stats);
    match event_callback.call_with_return_value(
        event,
        ThreadsafeFunctionCallMode::NonBlocking,
        move |_, _| {
            callback_stats.release_event_queue_slots(1);
            Ok(())
        },
    ) {
        Status::Ok => Ok(()),
        Status::Closing => {
            stats.release_event_queue_slots(1);
            Ok(())
        }
        Status::QueueFull => {
            stats.release_event_queue_slots(1);
            stats.record_event_queue_drop(1);
            Ok(())
        }
        status => Err(format!("TCP event callback failed: {status}").into()),
    }
}

fn handle_accept<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    listen_fd: RawFd,
    result: i32,
    flags: u32,
    context: &mut AcceptContext<'_>,
) -> Result<(), UringError> {
    if result >= 0 {
        let fd = result;
        if connection_limit_reached(context.connections.len(), context.max_connections) {
            reject_connection(fd, context.stats);
        } else {
            configure_accepted_socket(
                fd,
                context.tcp_no_delay,
                context.socket_recv_buffer_size,
                context.socket_send_buffer_size,
            );
            let connection_id = *context.next_connection_id;
            *context.next_connection_id = context.next_connection_id.wrapping_add(1).max(1);
            context.connections.insert(
                fd,
                Connection {
                    id: connection_id,
                    send_offset: 0,
                    send_started: false,
                    zero_copy_disabled: false,
                    registered_send_disabled: false,
                    recv_active: true,
                    last_activity: Instant::now(),
                },
            );
            context.id_to_fd.insert(connection_id, fd);
            context.stats.record_connection_open();
            submit_tcp_recv_multi(
                ring,
                fd,
                connection_id,
                context.buffer_size,
                context.use_recv_bundle,
            )?;
        }
    }

    if !cqueue::more(flags) {
        submit_accept_multi(ring, listen_fd)?;
    }
    Ok(())
}

fn handle_zcrx_accept(
    ring: &mut ZcrxRing,
    listen_fd: RawFd,
    result: i32,
    flags: u32,
    zcrx_id: u32,
    context: &mut AcceptContext<'_>,
) -> Result<(), UringError> {
    if result >= 0 {
        let fd = result;
        if connection_limit_reached(context.connections.len(), context.max_connections) {
            reject_connection(fd, context.stats);
        } else {
            configure_accepted_socket(
                fd,
                context.tcp_no_delay,
                context.socket_recv_buffer_size,
                context.socket_send_buffer_size,
            );
            let connection_id = *context.next_connection_id;
            *context.next_connection_id = context.next_connection_id.wrapping_add(1).max(1);
            context.connections.insert(
                fd,
                Connection {
                    id: connection_id,
                    send_offset: 0,
                    send_started: false,
                    zero_copy_disabled: false,
                    registered_send_disabled: false,
                    recv_active: true,
                    last_activity: Instant::now(),
                },
            );
            context.id_to_fd.insert(connection_id, fd);
            context.stats.record_connection_open();
            submit_zcrx_recv_multi(ring, fd, connection_id, zcrx_id, context.buffer_size)?;
        }
    }

    if !cqueue::more(flags) {
        submit_accept_multi(ring, listen_fd)?;
    }
    Ok(())
}

fn handle_recv<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    result: i32,
    flags: u32,
    context: &mut RecvContext<'_>,
) -> Result<(), UringError> {
    let Some(connection) = context.connections.get(&fd) else {
        if result > 0 {
            if let Some(bid) = cqueue::buffer_select(flags) {
                context.buffers.discard_recv(
                    ring,
                    bid,
                    result as usize,
                    context.use_recv_bundle,
                    context.stats,
                )?;
            }
        }
        return Ok(());
    };
    if connection.id != connection_id {
        if result > 0 {
            if let Some(bid) = cqueue::buffer_select(flags) {
                context.buffers.discard_recv(
                    ring,
                    bid,
                    result as usize,
                    context.use_recv_bundle,
                    context.stats,
                )?;
            }
        }
        return Ok(());
    }

    if result == -libc::ENOBUFS {
        recover_recv_buffer_starvation(
            ring,
            fd,
            connection_id,
            context.buffer_size,
            context.use_recv_bundle,
            context.stats,
        )?;
        return Ok(());
    }

    if result <= 0 {
        close_connection(fd, context.connections, context.id_to_fd, context.stats);
        return Ok(());
    }

    mark_connection_activity(context.connections, fd);
    let mut should_send = false;
    if let Some(bid) = cqueue::buffer_select(flags) {
        let mut request = HttpRequestProbe::default();
        context.buffers.visit_recv(
            ring,
            bid,
            result as usize,
            context.use_recv_bundle,
            context.stats,
            |chunk| request.observe(chunk),
        )?;
        context.stats.record_bytes_received(request.bytes);

        if request.should_respond() {
            if let Some(connection) = context.connections.get_mut(&fd) {
                if !connection.send_started {
                    connection.send_started = true;
                    should_send = true;
                }
            }
        }
    }
    if should_send {
        let use_zc = context
            .connections
            .get(&fd)
            .map(|connection| context.use_zero_copy_send && !connection.zero_copy_disabled)
            .unwrap_or(false);
        let use_registered_send_buffer = context
            .connections
            .get(&fd)
            .map(|connection| {
                context.registered_send_buffer && !connection.registered_send_disabled
            })
            .unwrap_or(false);
        submit_send(
            ring,
            fd,
            connection_id,
            context.response,
            HttpSendOptions {
                offset: 0,
                use_zero_copy_send: use_zc,
                registered_send_buffer: use_registered_send_buffer,
            },
            context.stats,
        )?;
    }

    if !cqueue::more(flags) {
        if let Some(connection) = context.connections.get_mut(&fd) {
            connection.recv_active = false;
        }
        resubmit_tcp_recv_multi(
            ring,
            fd,
            connection_id,
            context.buffer_size,
            context.use_recv_bundle,
            context.stats,
        )?;
        if let Some(connection) = context.connections.get_mut(&fd) {
            connection.recv_active = true;
        }
    }
    Ok(())
}

fn handle_zcrx_recv(
    ring: &mut ZcrxRing,
    fd: RawFd,
    connection_id: u32,
    cqe: &cqueue::Entry32,
    context: &mut ZcrxRecvContext<'_>,
) -> Result<(), UringError> {
    let Some(connection) = context.connections.get(&fd) else {
        if cqe.result() > 0 {
            if let Some(packet) = context.zcrx.decode_packet(cqe)? {
                context.zcrx.recycle_packet(packet)?;
            }
        }
        return Ok(());
    };
    if connection.id != connection_id {
        if cqe.result() > 0 {
            if let Some(packet) = context.zcrx.decode_packet(cqe)? {
                context.zcrx.recycle_packet(packet)?;
            }
        }
        return Ok(());
    }

    if cqe.result() <= 0 {
        close_connection(fd, context.connections, context.id_to_fd, context.stats);
        return Ok(());
    }

    let packet = match context.zcrx.decode_packet(cqe)? {
        Some(packet) => packet,
        None => {
            close_connection(fd, context.connections, context.id_to_fd, context.stats);
            return Ok(());
        }
    };
    let should_respond = {
        let request = context.zcrx.packet_bytes(packet);
        context.stats.record_zcrx_packet(request.len());
        context.stats.record_bytes_received(request.len());
        mark_connection_activity(context.connections, fd);
        request.windows(4).any(|window| window == b"\r\n\r\n")
            || request.starts_with(b"GET ")
            || request.starts_with(b"POST ")
    };
    context.zcrx.recycle_packet(packet)?;

    let mut should_send = false;
    if should_respond {
        if let Some(connection) = context.connections.get_mut(&fd) {
            if !connection.send_started {
                connection.send_started = true;
                should_send = true;
            }
        }
    }
    if should_send {
        let use_zc = context
            .connections
            .get(&fd)
            .map(|connection| context.use_zero_copy_send && !connection.zero_copy_disabled)
            .unwrap_or(false);
        let use_registered_send_buffer = context
            .connections
            .get(&fd)
            .map(|connection| {
                context.registered_send_buffer && !connection.registered_send_disabled
            })
            .unwrap_or(false);
        submit_send(
            ring,
            fd,
            connection_id,
            context.response,
            HttpSendOptions {
                offset: 0,
                use_zero_copy_send: use_zc,
                registered_send_buffer: use_registered_send_buffer,
            },
            context.stats,
        )?;
    }

    if !cqueue::more(cqe.flags()) {
        if let Some(connection) = context.connections.get_mut(&fd) {
            connection.recv_active = false;
        }
        submit_zcrx_recv_multi(
            ring,
            fd,
            connection_id,
            context.zcrx.zcrx_id,
            context.buffer_size,
        )?;
        if let Some(connection) = context.connections.get_mut(&fd) {
            connection.recv_active = true;
        }
    }
    Ok(())
}

fn handle_send<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    result: i32,
    context: &mut SendContext<'_>,
) -> Result<(), UringError> {
    let Some(connection) = context.connections.get_mut(&fd) else {
        return Ok(());
    };

    if result < 0 && context.use_zero_copy_send && !connection.zero_copy_disabled {
        context.stats.record_zero_copy_send_error();
        connection.zero_copy_disabled = true;
        let offset = connection.send_offset;
        let use_registered_send_buffer =
            context.registered_send_buffer && !connection.registered_send_disabled;
        submit_send(
            ring,
            fd,
            connection_id,
            context.response,
            HttpSendOptions {
                offset,
                use_zero_copy_send: false,
                registered_send_buffer: use_registered_send_buffer,
            },
            context.stats,
        )?;
        return Ok(());
    }

    if result < 0 && context.registered_send_buffer && !connection.registered_send_disabled {
        context.stats.record_registered_send_error();
        connection.registered_send_disabled = true;
        let offset = connection.send_offset;
        submit_send(
            ring,
            fd,
            connection_id,
            context.response,
            HttpSendOptions {
                offset,
                use_zero_copy_send: false,
                registered_send_buffer: false,
            },
            context.stats,
        )?;
        return Ok(());
    }

    if result <= 0 {
        close_connection(fd, context.connections, context.id_to_fd, context.stats);
        return Ok(());
    }

    let bytes_sent = result as usize;
    context.stats.record_bytes_sent(bytes_sent);
    connection.send_offset += bytes_sent;
    let next_offset = connection.send_offset;
    if next_offset < context.response.len() {
        let use_zc = context.use_zero_copy_send && !connection.zero_copy_disabled;
        let use_registered_send_buffer =
            context.registered_send_buffer && !connection.registered_send_disabled;
        submit_send(
            ring,
            fd,
            connection_id,
            context.response,
            HttpSendOptions {
                offset: next_offset,
                use_zero_copy_send: use_zc,
                registered_send_buffer: use_registered_send_buffer,
            },
            context.stats,
        )?;
    } else {
        close_connection(fd, context.connections, context.id_to_fd, context.stats);
    }
    Ok(())
}

fn set_tcp_nodelay(fd: RawFd) {
    let value: libc::c_int = 1;
    // SAFETY: fd is an accepted TCP socket, and the option payload points to a
    // valid c_int for the duration of the setsockopt call.
    unsafe {
        let _ = libc::setsockopt(
            fd,
            libc::IPPROTO_TCP,
            libc::TCP_NODELAY,
            (&value as *const libc::c_int).cast::<libc::c_void>(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
}

fn configure_accepted_socket(
    fd: RawFd,
    tcp_no_delay: bool,
    socket_recv_buffer_size: u32,
    socket_send_buffer_size: u32,
) {
    if tcp_no_delay {
        set_tcp_nodelay(fd);
    }
    let _ = apply_socket_buffer_sizes(fd, socket_recv_buffer_size, socket_send_buffer_size);
}

fn bind_tcp_listener(
    host: &str,
    port: u16,
    backlog: u32,
    reuse_port: bool,
    tcp_defer_accept_seconds: u32,
    socket_recv_buffer_size: u32,
    socket_send_buffer_size: u32,
) -> io::Result<TcpListener> {
    let mut last_error = None;
    for address in (host, port).to_socket_addrs()? {
        match bind_tcp_listener_addr(
            address,
            backlog,
            reuse_port,
            tcp_defer_accept_seconds,
            socket_recv_buffer_size,
            socket_send_buffer_size,
        ) {
            Ok(listener) => return Ok(listener),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("could not resolve TCP bind address {host}:{port}"),
        )
    }))
}

fn bind_tcp_listener_addr(
    address: SocketAddr,
    backlog: u32,
    reuse_port: bool,
    tcp_defer_accept_seconds: u32,
    socket_recv_buffer_size: u32,
    socket_send_buffer_size: u32,
) -> io::Result<TcpListener> {
    let domain = match address {
        SocketAddr::V4(_) => libc::AF_INET,
        SocketAddr::V6(_) => libc::AF_INET6,
    };
    // SAFETY: socket has no pointer arguments, and the returned fd is checked
    // and either wrapped in TcpListener or closed on every error path.
    let fd = unsafe {
        libc::socket(
            domain,
            libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
            libc::IPPROTO_TCP,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    if let Err(error) = set_socket_reuseaddr(fd) {
        close_raw_fd(fd);
        return Err(error);
    }
    if reuse_port {
        if let Err(error) = set_socket_reuseport(fd) {
            close_raw_fd(fd);
            return Err(error);
        }
    }
    if tcp_defer_accept_seconds != 0 {
        if let Err(error) = set_tcp_defer_accept(fd, tcp_defer_accept_seconds) {
            close_raw_fd(fd);
            return Err(error);
        }
    }
    if let Err(error) =
        apply_socket_buffer_sizes(fd, socket_recv_buffer_size, socket_send_buffer_size)
    {
        close_raw_fd(fd);
        return Err(error);
    }

    let (storage, len) = socket_addr_to_raw(&address);
    // SAFETY: storage contains a sockaddr matching len, produced by
    // socket_addr_to_raw for the selected address family.
    let bind_result =
        unsafe { libc::bind(fd, (&storage as *const libc::sockaddr_storage).cast(), len) };
    if bind_result < 0 {
        let error = io::Error::last_os_error();
        close_raw_fd(fd);
        return Err(error);
    }

    // SAFETY: fd is a valid bound TCP socket and backlog was validated to fit
    // the c_int range before reaching this native config.
    if unsafe { libc::listen(fd, backlog as libc::c_int) } < 0 {
        let error = io::Error::last_os_error();
        close_raw_fd(fd);
        return Err(error);
    }

    // SAFETY: fd is a uniquely owned listening socket at this point; ownership
    // is transferred to TcpListener so it will close on drop.
    Ok(unsafe { TcpListener::from_raw_fd(fd) })
}

fn set_socket_reuseaddr(fd: RawFd) -> io::Result<()> {
    let value: libc::c_int = 1;
    // SAFETY: fd is an open socket, and the option payload points to a valid
    // c_int for the duration of the setsockopt call.
    let result = unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_REUSEADDR,
            (&value as *const libc::c_int).cast::<libc::c_void>(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn set_socket_reuseport(fd: RawFd) -> io::Result<()> {
    let value: libc::c_int = 1;
    // SAFETY: fd is an open socket, and the option payload points to a valid
    // c_int for the duration of the setsockopt call.
    let result = unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_REUSEPORT,
            (&value as *const libc::c_int).cast::<libc::c_void>(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn set_tcp_defer_accept(fd: RawFd, seconds: u32) -> io::Result<()> {
    debug_assert!(seconds <= libc::c_int::MAX as u32);
    let value = seconds as libc::c_int;
    // SAFETY: fd is an open TCP socket, and the option payload points to a
    // valid c_int for the duration of the setsockopt call.
    let result = unsafe {
        libc::setsockopt(
            fd,
            libc::IPPROTO_TCP,
            libc::TCP_DEFER_ACCEPT,
            (&value as *const libc::c_int).cast::<libc::c_void>(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn apply_socket_buffer_sizes(
    fd: RawFd,
    socket_recv_buffer_size: u32,
    socket_send_buffer_size: u32,
) -> io::Result<()> {
    if socket_recv_buffer_size != 0 {
        set_socket_buffer_size(fd, libc::SO_RCVBUF, socket_recv_buffer_size)?;
    }
    if socket_send_buffer_size != 0 {
        set_socket_buffer_size(fd, libc::SO_SNDBUF, socket_send_buffer_size)?;
    }
    Ok(())
}

fn set_socket_buffer_size(fd: RawFd, option: libc::c_int, size: u32) -> io::Result<()> {
    debug_assert!(size <= libc::c_int::MAX as u32);
    let value = size as libc::c_int;
    // SAFETY: fd is an open socket, option is supplied by this module, and the
    // payload points to a valid c_int for the duration of the setsockopt call.
    let result = unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            option,
            (&value as *const libc::c_int).cast::<libc::c_void>(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn socket_addr_to_raw(address: &SocketAddr) -> (libc::sockaddr_storage, libc::socklen_t) {
    // SAFETY: sockaddr_storage is a plain C storage buffer; it is fully
    // initialized below with the matching sockaddr variant before being read.
    let mut storage = unsafe { std::mem::zeroed::<libc::sockaddr_storage>() };
    match address {
        SocketAddr::V4(address) => {
            let sockaddr = libc::sockaddr_in {
                sin_family: libc::AF_INET as libc::sa_family_t,
                sin_port: address.port().to_be(),
                sin_addr: libc::in_addr {
                    s_addr: u32::from_ne_bytes(address.ip().octets()),
                },
                sin_zero: [0; 8],
            };
            // SAFETY: storage has enough size and alignment for sockaddr_in;
            // the returned length identifies the initialized prefix.
            unsafe {
                std::ptr::write(
                    (&mut storage as *mut libc::sockaddr_storage).cast::<libc::sockaddr_in>(),
                    sockaddr,
                );
            }
            (
                storage,
                std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
            )
        }
        SocketAddr::V6(address) => {
            let sockaddr = libc::sockaddr_in6 {
                sin6_family: libc::AF_INET6 as libc::sa_family_t,
                sin6_port: address.port().to_be(),
                sin6_flowinfo: address.flowinfo(),
                sin6_addr: libc::in6_addr {
                    s6_addr: address.ip().octets(),
                },
                sin6_scope_id: address.scope_id(),
            };
            // SAFETY: storage has enough size and alignment for sockaddr_in6;
            // the returned length identifies the initialized prefix.
            unsafe {
                std::ptr::write(
                    (&mut storage as *mut libc::sockaddr_storage).cast::<libc::sockaddr_in6>(),
                    sockaddr,
                );
            }
            (
                storage,
                std::mem::size_of::<libc::sockaddr_in6>() as libc::socklen_t,
            )
        }
    }
}

fn submit_accept_multi<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    listen_fd: RawFd,
) -> Result<(), UringError> {
    let entry = opcode::AcceptMulti::new(types::Fd(listen_fd))
        .flags(libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC)
        .build()
        .user_data(pack_user_data(OP_ACCEPT, listen_fd));
    push_entry(ring, entry)
}

fn register_response_buffer<C: cqueue::EntryMarker>(
    ring: &Ring<C>,
    response: &Arc<[u8]>,
) -> Result<(), UringError> {
    let iovec = libc::iovec {
        iov_base: response.as_ptr() as *mut libc::c_void,
        iov_len: response.len(),
    };
    // SAFETY: iovec points into `response`, which is an Arc kept alive by the
    // server for the full ring lifetime while the buffer is registered.
    unsafe {
        ring.submitter().register_buffers(&[iovec])?;
    }
    Ok(())
}

fn submit_tcp_recv_multi<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    _buffer_size: u32,
    use_recv_bundle: bool,
) -> Result<(), UringError> {
    let entry = build_tcp_recv_multi_entry(fd, connection_id, use_recv_bundle);
    push_entry(ring, entry)
}

fn resubmit_tcp_recv_multi<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    buffer_size: u32,
    use_recv_bundle: bool,
    stats: &TransportStats,
) -> Result<(), UringError> {
    stats.record_recv_multishot_resubmit();
    submit_tcp_recv_multi(ring, fd, connection_id, buffer_size, use_recv_bundle)
}

fn recover_recv_buffer_starvation<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    buffer_size: u32,
    use_recv_bundle: bool,
    stats: &TransportStats,
) -> Result<(), UringError> {
    stats.record_recv_buffer_starvation();
    resubmit_tcp_recv_multi(ring, fd, connection_id, buffer_size, use_recv_bundle, stats)
}

fn build_tcp_recv_multi_entry(
    fd: RawFd,
    connection_id: u32,
    use_recv_bundle: bool,
) -> squeue::Entry {
    if use_recv_bundle {
        opcode::RecvMultiBundle::new(types::Fd(fd), BGID)
            .build()
            .user_data(pack_connection_user_data(OP_RECV, connection_id))
    } else {
        opcode::RecvMulti::new(types::Fd(fd), BGID)
            .build()
            .user_data(pack_connection_user_data(OP_RECV, connection_id))
    }
}

fn submit_zcrx_recv_multi(
    ring: &mut ZcrxRing,
    fd: RawFd,
    connection_id: u32,
    zcrx_id: u32,
    buffer_size: u32,
) -> Result<(), UringError> {
    let entry = build_zcrx_recv_multi_entry(fd, connection_id, zcrx_id, buffer_size);
    push_entry(ring, entry)
}

fn build_zcrx_recv_multi_entry(
    fd: RawFd,
    connection_id: u32,
    zcrx_id: u32,
    buffer_size: u32,
) -> squeue::Entry {
    opcode::RecvZc::new(types::Fd(fd), buffer_size)
        .ifq(zcrx_id)
        .build()
        .user_data(pack_connection_user_data(OP_RECV, connection_id))
}

fn submit_send<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    fd: RawFd,
    connection_id: u32,
    response: &Arc<[u8]>,
    options: HttpSendOptions,
    stats: &TransportStats,
) -> Result<(), UringError> {
    let remaining = response.len() - options.offset;
    // SAFETY: options.offset is only advanced from completed send byte counts
    // and is kept within response.len().
    let ptr = unsafe { response.as_ptr().add(options.offset) };
    if options.use_zero_copy_send {
        stats.record_zero_copy_send_request();
    }
    if options.registered_send_buffer {
        stats.record_registered_send_request();
    }
    let entry = build_send_entry(
        fd,
        connection_id,
        ptr,
        remaining as u32,
        options.use_zero_copy_send,
        options.registered_send_buffer,
    );
    push_entry(ring, entry)
}

fn build_send_entry(
    fd: RawFd,
    connection_id: u32,
    ptr: *const u8,
    len: u32,
    use_zero_copy_send: bool,
    registered_send_buffer: bool,
) -> squeue::Entry {
    if use_zero_copy_send {
        let mut send = opcode::SendZc::new(types::Fd(fd), ptr, len)
            .flags(libc::MSG_NOSIGNAL)
            .zc_flags(SEND_ZC_REPORT_USAGE);
        if registered_send_buffer {
            send = send.buf_index(Some(0));
        }
        send.build()
            .user_data(pack_connection_user_data(OP_SEND, connection_id))
    } else {
        let mut entry = opcode::Send::new(types::Fd(fd), ptr, len)
            .flags(libc::MSG_NOSIGNAL)
            .build();
        if registered_send_buffer {
            set_send_fixed_buffer(&mut entry, 0);
        }
        entry.user_data(pack_connection_user_data(OP_SEND, connection_id))
    }
}

fn push_entry<C: cqueue::EntryMarker>(
    ring: &mut Ring<C>,
    entry: squeue::Entry,
) -> Result<(), UringError> {
    loop {
        // SAFETY: entry is copied into the submission queue before this stack
        // value goes out of scope; on full SQ we submit and retry.
        let pushed = unsafe { ring.submission().push(&entry) };
        if pushed.is_ok() {
            return Ok(());
        }
        ring.submit()?;
    }
}

fn wait_for_completions<C: cqueue::EntryMarker>(ring: &Ring<C>) -> Result<(), UringError> {
    let timeout = Timespec::from(Duration::from_millis(100));
    let args = SubmitArgs::new().timespec(&timeout);
    match ring.submitter().submit_with_args(1, &args) {
        Ok(_) => Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::ETIME) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn make_response(body: &[u8]) -> Vec<u8> {
    let headers = format!(
        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let mut response = headers.into_bytes();
    response.extend_from_slice(body);
    response
}

fn pack_user_data(op: u8, fd: RawFd) -> u64 {
    ((op as u64) << 56) | (fd as u32 as u64)
}

fn pack_connection_user_data(op: u8, connection_id: u32) -> u64 {
    ((op as u64) << 56) | connection_id as u64
}

fn unpack_user_data(user_data: u64) -> (u8, RawFd) {
    ((user_data >> 56) as u8, user_data as u32 as RawFd)
}

fn unpack_connection_id(token: RawFd) -> u32 {
    token as u32
}

fn close_connection(
    fd: RawFd,
    connections: &mut HashMap<RawFd, Connection>,
    id_to_fd: &mut HashMap<u32, RawFd>,
    stats: &TransportStats,
) {
    if let Some(connection) = connections.remove(&fd) {
        id_to_fd.remove(&connection.id);
        close_fd(fd);
        stats.record_connection_close();
    }
}

fn connection_limit_reached(current_connections: usize, max_connections: u32) -> bool {
    max_connections != 0 && current_connections >= max_connections as usize
}

fn reject_connection(fd: RawFd, stats: &TransportStats) {
    close_fd(fd);
    stats.record_connection_reject();
}

fn close_raw_fd(fd: RawFd) {
    // SAFETY: callers pass fds they own and do not use after this close helper.
    unsafe {
        libc::close(fd);
    }
}

fn close_fd(fd: RawFd) {
    // SAFETY: callers pass owned connection fds; shutdown may fail for already
    // closed peer state and is intentionally ignored before the final close.
    unsafe {
        libc::shutdown(fd, libc::SHUT_RDWR);
        libc::close(fd);
    }
}

fn wake_event_fd(fd: RawFd) {
    let value = 1_u64;
    // SAFETY: fd is an eventfd owned by the server/worker lifecycle, and the
    // write buffer points to a valid u64 for the syscall duration.
    unsafe {
        let _ = libc::write(
            fd,
            (&value as *const u64).cast::<libc::c_void>(),
            std::mem::size_of::<u64>(),
        );
    }
}

fn default_zcrx_interface() -> Option<String> {
    let entries = fs::read_dir("/sys/class/net").ok()?;
    let mut fallback = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "lo" {
            continue;
        }
        if fallback.is_none() {
            fallback = Some(name.clone());
        }
        let operstate = read_trimmed(entry.path().join("operstate"));
        if operstate.as_deref() == Some("up") {
            return Some(name);
        }
    }
    fallback
}

fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn count_rx_queues(path: &Path) -> u32 {
    fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("rx-"))
                .count() as u32
        })
        .unwrap_or(0)
}

fn read_driver(interface_path: &Path) -> Option<String> {
    let driver_path = fs::read_link(interface_path.join("device/driver")).ok()?;
    driver_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

fn interface_index(interface_name: &str) -> Option<u32> {
    let c_name = CString::new(interface_name).ok()?;
    // SAFETY: c_name is a valid NUL-terminated interface name for the duration
    // of the libc call.
    let index = unsafe { libc::if_nametoindex(c_name.as_ptr()) };
    (index != 0).then_some(index)
}

fn ethtool_output(args: &[&str]) -> Option<String> {
    let output = Command::new("ethtool").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn feature_state(features: &str, names: &[&str]) -> Option<String> {
    for line in features.lines() {
        let trimmed = line.trim();
        for name in names {
            let Some(rest) = trimmed.strip_prefix(name) else {
                continue;
            };
            let Some(rest) = rest.strip_prefix(':') else {
                continue;
            };
            return rest
                .split_whitespace()
                .next()
                .map(|value| value.to_string());
        }
    }
    None
}

struct PeerInfo {
    formatted: String,
    address: String,
    family: String,
    port: u16,
}

fn peer_event_fields(fd: RawFd) -> (Option<String>, Option<String>, Option<String>, Option<u16>) {
    match peer_info(fd) {
        Some(peer) => (
            Some(peer.formatted),
            Some(peer.address),
            Some(peer.family),
            Some(peer.port),
        ),
        None => (None, None, None, None),
    }
}

fn peer_info(fd: RawFd) -> Option<PeerInfo> {
    let mut storage = std::mem::MaybeUninit::<libc::sockaddr_storage>::zeroed();
    let mut len = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
    // SAFETY: storage is valid writable sockaddr_storage memory and len points
    // to its capacity; getpeername initializes storage on success.
    let ok =
        unsafe { libc::getpeername(fd, storage.as_mut_ptr().cast::<libc::sockaddr>(), &mut len) }
            == 0;
    if !ok {
        return None;
    }

    // SAFETY: getpeername returned success, so storage has been initialized as
    // a sockaddr whose family is checked below before typed reads.
    let storage = unsafe { storage.assume_init() };
    match storage.ss_family as i32 {
        libc::AF_INET => {
            // SAFETY: ss_family identified the initialized storage as AF_INET.
            let addr = unsafe {
                std::ptr::read(
                    (&storage as *const libc::sockaddr_storage).cast::<libc::sockaddr_in>(),
                )
            };
            let ip = Ipv4Addr::from(u32::from_be(addr.sin_addr.s_addr));
            let port = u16::from_be(addr.sin_port);
            let address = ip.to_string();
            Some(PeerInfo {
                formatted: format!("{address}:{port}"),
                address,
                family: "IPv4".to_string(),
                port,
            })
        }
        libc::AF_INET6 => {
            // SAFETY: ss_family identified the initialized storage as AF_INET6.
            let addr = unsafe {
                std::ptr::read(
                    (&storage as *const libc::sockaddr_storage).cast::<libc::sockaddr_in6>(),
                )
            };
            let ip = Ipv6Addr::from(addr.sin6_addr.s6_addr);
            let port = u16::from_be(addr.sin6_port);
            let address = ip.to_string();
            Some(PeerInfo {
                formatted: format!("[{address}]:{port}"),
                address,
                family: "IPv6".to_string(),
                port,
            })
        }
        _ => None,
    }
}

fn kernel_release() -> String {
    let mut uts = std::mem::MaybeUninit::<libc::utsname>::uninit();
    // SAFETY: uts points to valid writable utsname storage and uname
    // initializes it on success.
    let ok = unsafe { libc::uname(uts.as_mut_ptr()) } == 0;
    if !ok {
        return "unknown".to_string();
    }
    // SAFETY: uname returned success, so uts has been initialized.
    let uts = unsafe { uts.assume_init() };
    let bytes = uts
        .release
        .iter()
        .take_while(|&&byte| byte != 0)
        .map(|&byte| byte as u8)
        .collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    struct TestSqePrefix {
        opcode: u8,
        flags: u8,
        ioprio: u16,
        fd: i32,
        off: u64,
        addr: u64,
        len: u32,
        msg_flags: u32,
        user_data: u64,
        buf_group: u16,
    }

    fn sqe_prefix(entry: &squeue::Entry) -> &TestSqePrefix {
        // SAFETY: TestSqePrefix mirrors the SQE prefix fields asserted by these
        // tests, and the reference only lives as long as the source entry.
        unsafe { &*(entry as *const squeue::Entry).cast::<TestSqePrefix>() }
    }

    fn test_server_info() -> ServerInfo {
        ServerInfo {
            host: "127.0.0.1".to_string(),
            port: 0,
            backend: "io_uring".to_string(),
            backlog: DEFAULT_BACKLOG,
            queue_depth: 8,
            buffer_count: 8,
            buffer_size: 512,
            max_connections: 0,
            rejected_connections: 0.0,
            idle_timeout_ms: 0,
            idle_timeouts: 0.0,
            tcp_no_delay: true,
            reuse_port: false,
            tcp_defer_accept_seconds: 0,
            socket_recv_buffer_size: 0,
            socket_send_buffer_size: 0,
            command_queue_capacity: 0,
            command_queue_drops: 0.0,
            event_queue_capacity: 0,
            event_queue_drops: 0.0,
            event_batch_size: 0,
            send_queue_capacity: 0,
            send_queue_drops: 0.0,
            send_buffer_count: 0,
            send_buffer_size: 0,
            active_connections: 0.0,
            accepted_connections: 0.0,
            closed_connections: 0.0,
            bytes_received: 0.0,
            bytes_sent: 0.0,
            multishot_accept: true,
            multishot_recv: true,
            provided_buffer_ring: true,
            recv_bundle: true,
            recv_bundle_completions: 0.0,
            recv_bundle_buffers: 0.0,
            recv_bundle_bytes: 0.0,
            recv_buffer_starvations: 0.0,
            recv_multishot_resubmits: 0.0,
            recv_copy_events: 0.0,
            recv_copy_bytes: 0.0,
            registered_send_buffer: false,
            registered_send_requests: 0.0,
            registered_send_errors: 0.0,
            fixed_send_buffer_misses: 0.0,
            fixed_send_buffer_miss_bytes: 0.0,
            zero_copy_send: false,
            zero_copy_send_requests: 0.0,
            zero_copy_send_notifications: 0.0,
            zero_copy_send_copied: 0.0,
            zero_copy_send_errors: 0.0,
            zero_copy_receive: false,
            zcrx_ready: false,
            zcrx_rx_buffer_size: 0,
            zcrx_packets: 0.0,
            zcrx_bytes: 0.0,
        }
    }

    #[test]
    fn tcp_recv_multishot_uses_zero_len_with_provided_buffers() {
        let entry = build_tcp_recv_multi_entry(42, 99, false);
        let sqe = sqe_prefix(&entry);
        assert_eq!(sqe.opcode, opcode::RecvMulti::CODE);
        assert_eq!(sqe.ioprio, 1 << 1);
        assert_eq!(sqe.fd, 42);
        assert_ne!(sqe.flags & (1 << 5), 0);
        assert_eq!(sqe.len, 0);
        assert_eq!(sqe.buf_group, BGID);
        assert_eq!(
            entry.get_user_data(),
            pack_connection_user_data(OP_RECV, 99)
        );
    }

    #[test]
    fn tcp_recv_multishot_bundle_sets_bundle_flag() {
        let entry = build_tcp_recv_multi_entry(42, 99, true);
        let sqe = sqe_prefix(&entry);
        assert_eq!(sqe.opcode, opcode::RecvMultiBundle::CODE);
        assert_ne!(sqe.ioprio & (1 << 1), 0);
        assert_ne!(sqe.ioprio & (1 << 4), 0);
        assert_eq!(sqe.fd, 42);
        assert_ne!(sqe.flags & (1 << 5), 0);
        assert_eq!(sqe.len, 0);
        assert_eq!(sqe.buf_group, BGID);
        assert_eq!(
            entry.get_user_data(),
            pack_connection_user_data(OP_RECV, 99)
        );
    }

    #[test]
    fn zcrx_recv_uses_effective_rx_buffer_size() {
        let entry = build_zcrx_recv_multi_entry(42, 99, 7, 8192);
        let sqe = sqe_prefix(&entry);
        assert_eq!(sqe.opcode, opcode::RecvZc::CODE);
        assert_eq!(sqe.fd, 42);
        assert_eq!(sqe.len, 8192);
        assert_eq!(
            entry.get_user_data(),
            pack_connection_user_data(OP_RECV, 99)
        );
    }

    #[test]
    fn send_zc_entry_requests_usage_reporting() {
        let payload = b"ok";
        let entry = build_send_entry(42, 99, payload.as_ptr(), payload.len() as u32, true, true);
        let sqe = sqe_prefix(&entry);
        assert_eq!(sqe.opcode, opcode::SendZc::CODE);
        assert_ne!(sqe.ioprio & SEND_ZC_REPORT_USAGE, 0);
        assert_eq!(sqe.fd, 42);
        assert_eq!(sqe.len, 2);
        assert_eq!(sqe.msg_flags, libc::MSG_NOSIGNAL as u32);
        assert_eq!(
            entry.get_user_data(),
            pack_connection_user_data(OP_SEND, 99)
        );
    }

    #[test]
    fn plain_send_entry_can_use_registered_buffer() {
        let payload = b"ok";
        let mut entry = opcode::Send::new(types::Fd(42), payload.as_ptr(), payload.len() as u32)
            .flags(libc::MSG_NOSIGNAL)
            .build()
            .user_data(pack_connection_user_data(OP_SEND, 99));
        set_send_fixed_buffer(&mut entry, 7);
        let sqe = sqe_prefix(&entry);
        assert_eq!(sqe.opcode, opcode::Send::CODE);
        assert_ne!(sqe.ioprio & RECVSEND_FIXED_BUF, 0);
        assert_eq!(sqe.buf_group, 7);
        assert_eq!(sqe.fd, 42);
        assert_eq!(sqe.len, 2);
        assert_eq!(sqe.msg_flags, libc::MSG_NOSIGNAL as u32);
        assert_eq!(
            entry.get_user_data(),
            pack_connection_user_data(OP_SEND, 99)
        );
    }

    #[test]
    fn http_plain_send_entry_can_use_registered_buffer() {
        let payload = b"ok";
        let entry = build_send_entry(42, 99, payload.as_ptr(), payload.len() as u32, false, true);
        let sqe = sqe_prefix(&entry);
        assert_eq!(sqe.opcode, opcode::Send::CODE);
        assert_ne!(sqe.ioprio & RECVSEND_FIXED_BUF, 0);
        assert_eq!(sqe.buf_group, 0);
        assert_eq!(sqe.fd, 42);
        assert_eq!(sqe.len, 2);
        assert_eq!(sqe.msg_flags, libc::MSG_NOSIGNAL as u32);
        assert_eq!(
            entry.get_user_data(),
            pack_connection_user_data(OP_SEND, 99)
        );
    }

    #[test]
    fn transport_stats_report_receive_health() {
        let stats = TransportStats::default();
        stats.record_recv_bundle(2, 1024);
        stats.record_recv_buffer_starvation();
        stats.record_recv_multishot_resubmit();
        stats.record_recv_copy(512);
        stats.record_fixed_send_buffer_miss(2048);
        stats.record_command_queue_drop();
        stats.record_event_queue_drop(3);
        stats.record_send_queue_drop();
        stats.record_connection_open();
        stats.record_connection_reject();
        stats.record_idle_timeout();
        stats.record_zcrx_packet(96);
        stats.record_bytes_received(128);
        stats.record_bytes_sent(64);
        stats.record_connection_close();

        let mut info = ServerInfo {
            host: "127.0.0.1".to_string(),
            port: 0,
            backend: "io_uring".to_string(),
            backlog: DEFAULT_BACKLOG,
            queue_depth: 8,
            buffer_count: 8,
            buffer_size: 512,
            max_connections: 0,
            rejected_connections: 0.0,
            idle_timeout_ms: 0,
            idle_timeouts: 0.0,
            tcp_no_delay: true,
            reuse_port: false,
            tcp_defer_accept_seconds: 0,
            socket_recv_buffer_size: 0,
            socket_send_buffer_size: 0,
            command_queue_capacity: 0,
            command_queue_drops: 0.0,
            event_queue_capacity: 0,
            event_queue_drops: 0.0,
            event_batch_size: 0,
            send_queue_capacity: 0,
            send_queue_drops: 0.0,
            send_buffer_count: 0,
            send_buffer_size: 0,
            active_connections: 0.0,
            accepted_connections: 0.0,
            closed_connections: 0.0,
            bytes_received: 0.0,
            bytes_sent: 0.0,
            multishot_accept: true,
            multishot_recv: true,
            provided_buffer_ring: true,
            recv_bundle: true,
            recv_bundle_completions: 0.0,
            recv_bundle_buffers: 0.0,
            recv_bundle_bytes: 0.0,
            recv_buffer_starvations: 0.0,
            recv_multishot_resubmits: 0.0,
            recv_copy_events: 0.0,
            recv_copy_bytes: 0.0,
            registered_send_buffer: false,
            registered_send_requests: 0.0,
            registered_send_errors: 0.0,
            fixed_send_buffer_misses: 0.0,
            fixed_send_buffer_miss_bytes: 0.0,
            zero_copy_send: false,
            zero_copy_send_requests: 0.0,
            zero_copy_send_notifications: 0.0,
            zero_copy_send_copied: 0.0,
            zero_copy_send_errors: 0.0,
            zero_copy_receive: false,
            zcrx_ready: false,
            zcrx_rx_buffer_size: 0,
            zcrx_packets: 0.0,
            zcrx_bytes: 0.0,
        };

        stats.apply_to_info(&mut info);

        assert_eq!(info.recv_bundle_completions, 1.0);
        assert_eq!(info.recv_bundle_buffers, 2.0);
        assert_eq!(info.recv_bundle_bytes, 1024.0);
        assert_eq!(info.recv_buffer_starvations, 1.0);
        assert_eq!(info.recv_multishot_resubmits, 1.0);
        assert_eq!(info.recv_copy_events, 1.0);
        assert_eq!(info.recv_copy_bytes, 512.0);
        assert_eq!(info.fixed_send_buffer_misses, 1.0);
        assert_eq!(info.fixed_send_buffer_miss_bytes, 2048.0);
        assert_eq!(info.command_queue_drops, 1.0);
        assert_eq!(info.event_queue_drops, 3.0);
        assert_eq!(info.send_queue_drops, 1.0);
        assert_eq!(info.accepted_connections, 1.0);
        assert_eq!(info.rejected_connections, 1.0);
        assert_eq!(info.idle_timeouts, 1.0);
        assert_eq!(info.zcrx_packets, 1.0);
        assert_eq!(info.zcrx_bytes, 96.0);
        assert_eq!(info.closed_connections, 1.0);
        assert_eq!(info.active_connections, 0.0);
        assert_eq!(info.bytes_received, 128.0);
        assert_eq!(info.bytes_sent, 64.0);
    }

    #[test]
    fn transport_stats_counters_exceed_u32_without_saturating() {
        let stats = TransportStats::default();
        stats
            .bytes_received
            .store(u32::MAX as u64 + 17, Ordering::Relaxed);
        stats
            .accepted_connections
            .store(u32::MAX as u64 + 3, Ordering::Relaxed);
        stats
            .zcrx_bytes
            .store(MAX_SAFE_JS_INTEGER + 99, Ordering::Relaxed);

        let mut info = test_server_info();
        stats.apply_to_info(&mut info);

        assert_eq!(info.bytes_received, u32::MAX as f64 + 17.0);
        assert_eq!(info.accepted_connections, u32::MAX as f64 + 3.0);
        assert_eq!(info.zcrx_bytes, MAX_SAFE_JS_INTEGER as f64);
    }

    #[test]
    fn http_request_probe_handles_split_headers_without_copy_buffer() {
        let mut probe = HttpRequestProbe::default();
        probe.observe(b"HE");
        probe.observe(b"AD / HTTP/1.1\r\nHost: local\r");
        assert!(!probe.should_respond());
        probe.observe(b"\n\r\n");
        assert!(probe.should_respond());
        assert_eq!(probe.bytes, b"HEAD / HTTP/1.1\r\nHost: local\r\n\r\n".len());
    }

    #[test]
    fn kernel_version_parser_handles_distro_suffixes() {
        assert_eq!(
            KernelVersion::parse("7.0.0-27-generic"),
            Some(KernelVersion::new(7, 0, 0))
        );
        assert_eq!(
            KernelVersion::parse("6.19.6"),
            Some(KernelVersion::new(6, 19, 6))
        );
        assert_eq!(
            KernelVersion::parse("6.19-rc1"),
            Some(KernelVersion::new(6, 19, 0))
        );
        assert_eq!(KernelVersion::parse("unknown"), None);
    }

    #[test]
    fn zcrx_kernel_security_warnings_cover_current_advisory_ranges() {
        let linux_615 = zcrx_kernel_security_warnings_for_release("6.15.0");
        assert!(linux_615
            .iter()
            .any(|warning| warning.contains("CVE-2026-43121")));
        assert!(linux_615
            .iter()
            .any(|warning| warning.contains("CVE-2026-43174")));

        let linux_618 = zcrx_kernel_security_warnings_for_release("6.18.15");
        assert!(linux_618
            .iter()
            .any(|warning| warning.contains("CVE-2026-43224")));

        let linux_619 = zcrx_kernel_security_warnings_for_release("6.19.5");
        assert!(linux_619
            .iter()
            .any(|warning| warning.contains("CVE-2026-45995")));

        let linux_700 = zcrx_kernel_security_warnings_for_release("7.0.0-27-generic");
        assert!(linux_700
            .iter()
            .any(|warning| warning.contains("CVE-2026-45995")));

        let linux_61816 = zcrx_kernel_security_warnings_for_release("6.18.16");
        assert!(!linux_61816
            .iter()
            .any(|warning| warning.contains("CVE-2026-43121")));
        assert!(linux_61816
            .iter()
            .any(|warning| warning.contains("CVE-2026-43174")));
        assert!(!linux_61816
            .iter()
            .any(|warning| warning.contains("CVE-2026-43224")));
        let linux_6196 = zcrx_kernel_security_warnings_for_release("6.19.6");
        assert!(!linux_6196
            .iter()
            .any(|warning| warning.contains("CVE-2026-43121")));
        assert!(!linux_6196
            .iter()
            .any(|warning| warning.contains("CVE-2026-43174")));
        assert!(!linux_6196
            .iter()
            .any(|warning| warning.contains("CVE-2026-43224")));
        assert!(linux_6196
            .iter()
            .any(|warning| warning.contains("CVE-2026-45995")));
        assert!(zcrx_kernel_security_warnings_for_release("7.0.4").is_empty());
        assert!(zcrx_kernel_security_warnings_for_release("7.1.0").is_empty());
    }

    #[test]
    fn zcrx_recycle_packet_returns_cqe_packet_extent() {
        let rx_buffer_size = 4096_u32;
        let rq_entries = 8_u32;
        let area = MappedRegion::new(rx_buffer_size as usize * rq_entries as usize)
            .expect("receive area mmap should succeed");
        let refill_queue =
            MappedRegion::new(4096).expect("refill queue mmap should succeed for test");
        let offsets = IoUringZcrxOffsets {
            head: 0,
            tail: 4,
            rqes: 8,
            ..Default::default()
        };
        let rq_area_token = 0xCAFE_u64 << ZCRX_AREA_OFFSET_BITS;
        let packet_offset = rx_buffer_size as u64 * 2;
        let mut registration = ZcrxRegistration {
            area,
            refill_queue,
            offsets,
            zcrx_id: 7,
            rx_buffer_size,
            rq_entries,
            rq_area_token,
            primed_refills: 0,
        };

        registration
            .recycle_packet(ZcrxPacket {
                offset: packet_offset,
                len: 37,
            })
            .expect("packet recycle should succeed");

        // SAFETY: the test refill queue mapping is initialized with a tail
        // offset that points at an AtomicU32 inside the mmap.
        let tail = unsafe {
            (*registration
                .refill_queue
                .at::<std::sync::atomic::AtomicU32>(registration.offsets.tail))
            .load(Ordering::Acquire)
        };
        // SAFETY: the test wrote one IoUringZcrxRqe at offsets.rqes via
        // recycle_packet, so reading that initialized slot is valid.
        let rqe = unsafe {
            std::ptr::read(
                registration
                    .refill_queue
                    .at::<IoUringZcrxRqe>(registration.offsets.rqes),
            )
        };
        assert_eq!(tail, 1);
        assert_eq!(rqe.off, rq_area_token | packet_offset);
        assert_eq!(rqe.len, 37);
    }
}
