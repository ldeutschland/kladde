use std::{
    ffi::{CStr, CString, c_char, c_int, c_void},
    marker::PhantomData,
    path::Path,
    pin::Pin,
    ptr,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
};

const RTLD_NOW: c_int = 0x2;
const RTLD_LOCAL: c_int = 0x4;
const STATUS_OK: c_int = 0;
const SAMPLER_TOP_P: c_int = 2;
const TOP_K: i32 = 64;
const TOP_P: f32 = 0.95;
const ERROR_LENGTH: usize = 300;
const LOAD_FAILED: &str = "Local model runtime unavailable";

unsafe extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;

    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

type Status = c_int;
type Handle = *mut c_void;
type Delete = unsafe extern "C" fn(Handle);
type ChunkCallback = unsafe extern "C" fn(*mut c_void, *const c_void);

struct Api {
    last_error: unsafe extern "C" fn() -> *const c_char,
    settings_create: unsafe extern "C" fn(
        *const c_char,
        *const c_char,
        *const c_char,
        *const c_char,
        *mut Handle,
    ) -> Status,
    settings_max_tokens: unsafe extern "C" fn(Handle, c_int) -> Status,
    settings_cache_dir: unsafe extern "C" fn(Handle, *const c_char) -> Status,
    settings_delete: Delete,
    engine_create: unsafe extern "C" fn(Handle, *mut Handle) -> Status,
    engine_delete: Delete,
    sampler_create: unsafe extern "C" fn(c_int, *mut Handle) -> Status,
    sampler_top_k: unsafe extern "C" fn(Handle, i32) -> Status,
    sampler_top_p: unsafe extern "C" fn(Handle, f32) -> Status,
    sampler_temperature: unsafe extern "C" fn(Handle, f32) -> Status,
    sampler_delete: Delete,
    session_create: unsafe extern "C" fn(*mut Handle) -> Status,
    session_sampler: unsafe extern "C" fn(Handle, Handle) -> Status,
    session_delete: Delete,
    thinking_create: unsafe extern "C" fn(*mut Handle) -> Status,
    thinking_enable: unsafe extern "C" fn(Handle, bool) -> Status,
    thinking_delete: Delete,
    config_create: unsafe extern "C" fn(*mut Handle) -> Status,
    config_session: unsafe extern "C" fn(Handle, Handle) -> Status,
    config_system: unsafe extern "C" fn(Handle, *const c_char) -> Status,
    config_tools: unsafe extern "C" fn(Handle, *const c_char) -> Status,
    config_thinking: unsafe extern "C" fn(Handle, Handle) -> Status,
    config_delete: Delete,
    conversation_create: unsafe extern "C" fn(Handle, Handle, *mut Handle) -> Status,
    conversation_delete: Delete,
    args_create: unsafe extern "C" fn(*mut Handle) -> Status,
    args_max_output: unsafe extern "C" fn(Handle, c_int) -> Status,
    args_delete: Delete,
    send_stream: unsafe extern "C" fn(
        Handle,
        *const c_char,
        *const c_char,
        Handle,
        ChunkCallback,
        *mut c_void,
    ) -> Status,
    chunk_text: unsafe extern "C" fn(*const c_void, *mut *const c_char) -> Status,
    chunk_final: unsafe extern "C" fn(*const c_void, *mut bool) -> Status,
    chunk_error: unsafe extern "C" fn(*const c_void, *mut *const c_char) -> Status,
    cancel: unsafe extern "C" fn(Handle) -> Status,
    token_count: unsafe extern "C" fn(Handle, *mut usize) -> Status,
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn symbol<T: Copy>(library: Handle, name: &str) -> Result<T, String> {
    let name = CString::new(name).map_err(|_| LOAD_FAILED)?;
    let address = unsafe { dlsym(library, name.as_ptr()) };

    if address.is_null() {
        return Err(LOAD_FAILED.into());
    }

    Ok(unsafe { std::mem::transmute_copy::<Handle, T>(&address) })
}

impl Api {
    fn load(library: Handle) -> Result<Self, String> {
        Ok(Self {
            last_error: symbol(library, "litert_lm_get_last_error_message")?,
            settings_create: symbol(library, "litert_lm_engine_settings_create")?,
            settings_max_tokens: symbol(library, "litert_lm_engine_settings_set_max_num_tokens")?,
            settings_cache_dir: symbol(library, "litert_lm_engine_settings_set_cache_dir")?,
            settings_delete: symbol(library, "litert_lm_engine_settings_delete")?,
            engine_create: symbol(library, "litert_lm_engine_create")?,
            engine_delete: symbol(library, "litert_lm_engine_delete")?,
            sampler_create: symbol(library, "litert_lm_sampler_params_create")?,
            sampler_top_k: symbol(library, "litert_lm_sampler_params_set_top_k")?,
            sampler_top_p: symbol(library, "litert_lm_sampler_params_set_top_p")?,
            sampler_temperature: symbol(library, "litert_lm_sampler_params_set_temperature")?,
            sampler_delete: symbol(library, "litert_lm_sampler_params_delete")?,
            session_create: symbol(library, "litert_lm_session_config_create")?,
            session_sampler: symbol(library, "litert_lm_session_config_set_sampler_params")?,
            session_delete: symbol(library, "litert_lm_session_config_delete")?,
            thinking_create: symbol(library, "litert_lm_thinking_config_create")?,
            thinking_enable: symbol(library, "litert_lm_thinking_config_set_enable_thinking")?,
            thinking_delete: symbol(library, "litert_lm_thinking_config_delete")?,
            config_create: symbol(library, "litert_lm_conversation_config_create")?,
            config_session: symbol(library, "litert_lm_conversation_config_set_session_config")?,
            config_system: symbol(library, "litert_lm_conversation_config_set_system_message")?,
            config_tools: symbol(library, "litert_lm_conversation_config_set_tools")?,
            config_thinking: symbol(library, "litert_lm_conversation_config_set_thinking_config")?,
            config_delete: symbol(library, "litert_lm_conversation_config_delete")?,
            conversation_create: symbol(library, "litert_lm_conversation_create")?,
            conversation_delete: symbol(library, "litert_lm_conversation_delete")?,
            args_create: symbol(library, "litert_lm_conversation_optional_args_create")?,
            args_max_output: symbol(
                library,
                "litert_lm_conversation_optional_args_set_max_output_tokens",
            )?,
            args_delete: symbol(library, "litert_lm_conversation_optional_args_delete")?,
            send_stream: symbol(library, "litert_lm_conversation_send_message_stream")?,
            chunk_text: symbol(library, "litert_lm_stream_chunk_get_text")?,
            chunk_final: symbol(library, "litert_lm_stream_chunk_is_final")?,
            chunk_error: symbol(library, "litert_lm_stream_chunk_get_error")?,
            cancel: symbol(library, "litert_lm_conversation_cancel_process")?,
            token_count: symbol(library, "litert_lm_conversation_get_token_count")?,
        })
    }
}

static API: OnceLock<Result<Api, String>> = OnceLock::new();

fn api(library: &Path) -> Result<&'static Api, String> {
    API.get_or_init(|| {
        let path = c_text(library.to_str().ok_or(LOAD_FAILED)?)?;
        let handle = unsafe { dlopen(path.as_ptr(), RTLD_NOW | RTLD_LOCAL) };

        if handle.is_null() {
            return Err(LOAD_FAILED.into());
        }

        Api::load(handle)
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn c_text(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "Invalid text".into())
}

fn clean(text: *const c_char) -> Option<String> {
    if text.is_null() {
        return None;
    }

    let raw = unsafe { CStr::from_ptr(text) }.to_string_lossy();

    Some(raw.into_owned())
}

fn checked(api: &Api, status: Status) -> Result<(), String> {
    if status == STATUS_OK {
        return Ok(());
    }

    let message = clean(unsafe { (api.last_error)() }).unwrap_or_default();
    let message: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(ERROR_LENGTH)
        .collect();

    Err(format!("{} ({status})", message.trim()))
}

struct Owned {
    raw: Handle,
    delete: Delete,
}

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { (self.delete)(self.raw) };
        }
    }
}

fn created(
    api: &Api,
    delete: Delete,
    make: impl FnOnce(*mut Handle) -> Status,
) -> Result<Owned, String> {
    let mut raw = ptr::null_mut();

    checked(api, make(&mut raw))?;

    Ok(Owned { raw, delete })
}

pub struct Engine {
    api: &'static Api,
    raw: Handle,
}

unsafe impl Send for Engine {}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe { (self.api.engine_delete)(self.raw) };
    }
}

pub struct Load<'a> {
    pub library: &'a Path,
    pub model: &'a Path,
    pub backend: &'a str,
    pub max_tokens: i32,
    pub cache: &'a Path,
}

impl Engine {
    pub fn load(load: &Load) -> Result<Self, String> {
        let api = api(load.library)?;
        let model = c_text(load.model.to_str().ok_or("Invalid model path")?)?;
        let backend = c_text(load.backend)?;
        let cache = c_text(load.cache.to_str().ok_or("Invalid cache path")?)?;
        let settings = created(api, api.settings_delete, |out| unsafe {
            (api.settings_create)(
                model.as_ptr(),
                backend.as_ptr(),
                ptr::null(),
                ptr::null(),
                out,
            )
        })?;

        checked(api, unsafe {
            (api.settings_max_tokens)(settings.raw, load.max_tokens)
        })?;
        checked(api, unsafe {
            (api.settings_cache_dir)(settings.raw, cache.as_ptr())
        })?;
        let mut raw = ptr::null_mut();

        checked(api, unsafe { (api.engine_create)(settings.raw, &mut raw) })?;

        Ok(Self { api, raw })
    }

    pub fn conversation(&self, setup: &Setup) -> Result<Conversation<'_>, String> {
        let api = self.api;
        let config = config(api, setup)?;
        let mut raw = ptr::null_mut();

        checked(api, unsafe {
            (api.conversation_create)(self.raw, config.raw, &mut raw)
        })?;

        Ok(Conversation {
            api,
            raw,
            sinks: Vec::new(),
            engine: PhantomData,
        })
    }
}

pub struct Setup<'a> {
    pub system: &'a str,
    pub tools: &'a str,
    pub temperature: f32,
}

fn sampler(api: &Api, temperature: f32) -> Result<Owned, String> {
    let sampler = created(api, api.sampler_delete, |out| unsafe {
        (api.sampler_create)(SAMPLER_TOP_P, out)
    })?;

    checked(api, unsafe { (api.sampler_top_k)(sampler.raw, TOP_K) })?;
    checked(api, unsafe { (api.sampler_top_p)(sampler.raw, TOP_P) })?;
    checked(api, unsafe {
        (api.sampler_temperature)(sampler.raw, temperature)
    })?;

    Ok(sampler)
}

fn session(api: &Api, temperature: f32) -> Result<Owned, String> {
    let sampler = sampler(api, temperature)?;
    let session = created(api, api.session_delete, |out| unsafe {
        (api.session_create)(out)
    })?;

    checked(api, unsafe {
        (api.session_sampler)(session.raw, sampler.raw)
    })?;

    Ok(session)
}

fn thinking_off(api: &Api) -> Result<Owned, String> {
    let thinking = created(api, api.thinking_delete, |out| unsafe {
        (api.thinking_create)(out)
    })?;

    checked(api, unsafe { (api.thinking_enable)(thinking.raw, false) })?;

    Ok(thinking)
}

fn config(api: &Api, setup: &Setup) -> Result<Owned, String> {
    let session = session(api, setup.temperature)?;
    let thinking = thinking_off(api)?;
    let system = c_text(setup.system)?;
    let config = created(api, api.config_delete, |out| unsafe {
        (api.config_create)(out)
    })?;

    checked(api, unsafe {
        (api.config_session)(config.raw, session.raw)
    })?;
    checked(api, unsafe {
        (api.config_thinking)(config.raw, thinking.raw)
    })?;
    checked(api, unsafe {
        (api.config_system)(config.raw, system.as_ptr())
    })?;

    if !setup.tools.is_empty() {
        let tools = c_text(setup.tools)?;

        checked(api, unsafe {
            (api.config_tools)(config.raw, tools.as_ptr())
        })?;
    }

    Ok(config)
}

pub enum Piece {
    Text(String),
    Done,
    Failed(String),
}

struct Sink {
    api: &'static Api,
    conversation: Handle,
    sender: Sender<Piece>,
    cancel: Arc<AtomicBool>,
    _message: CString,
    _args: Owned,
}

fn chunk_parts(api: &Api, chunk: *const c_void) -> (Option<String>, Option<String>, bool) {
    let mut text = ptr::null();
    let mut error = ptr::null();
    let mut last = false;
    let text = (unsafe { (api.chunk_text)(chunk, &mut text) } == STATUS_OK)
        .then(|| clean(text))
        .flatten();
    let error = (unsafe { (api.chunk_error)(chunk, &mut error) } == STATUS_OK)
        .then(|| clean(error))
        .flatten();
    let last = unsafe { (api.chunk_final)(chunk, &mut last) } == STATUS_OK && last;

    (text, error, last)
}

unsafe extern "C" fn on_chunk(data: *mut c_void, chunk: *const c_void) {
    let sink = unsafe { &*(data as *const Sink) };
    let (text, error, last) = chunk_parts(sink.api, chunk);

    if !last && sink.cancel.load(Ordering::Acquire) {
        unsafe { (sink.api.cancel)(sink.conversation) };
    }

    if let Some(text) = text {
        let _ = sink.sender.send(Piece::Text(text));
    }

    if let Some(error) = error {
        let _ = sink.sender.send(Piece::Failed(error));
    } else if last {
        let _ = sink.sender.send(Piece::Done);
    }
}

pub struct Conversation<'e> {
    api: &'static Api,
    raw: Handle,
    sinks: Vec<Pin<Box<Sink>>>,
    engine: PhantomData<&'e Engine>,
}

impl Drop for Conversation<'_> {
    fn drop(&mut self) {
        unsafe { (self.api.conversation_delete)(self.raw) };
    }
}

impl Conversation<'_> {
    pub fn send(
        &mut self,
        message: &str,
        max_output: i32,
        cancel: Arc<AtomicBool>,
    ) -> Result<Receiver<Piece>, String> {
        let api = self.api;
        let args = created(api, api.args_delete, |out| unsafe {
            (api.args_create)(out)
        })?;

        checked(api, unsafe { (api.args_max_output)(args.raw, max_output) })?;
        let (sender, receiver) = mpsc::channel();
        let sink = Box::pin(Sink {
            api,
            conversation: self.raw,
            sender,
            cancel,
            _message: c_text(message)?,
            _args: args,
        });
        let data = &*sink as *const Sink as *mut c_void;
        let started = unsafe {
            (api.send_stream)(
                self.raw,
                sink._message.as_ptr(),
                ptr::null(),
                sink._args.raw,
                on_chunk,
                data,
            )
        };

        self.sinks.push(sink);
        checked(api, started)?;

        Ok(receiver)
    }

    pub fn tokens(&self) -> Result<usize, String> {
        let mut count = 0;

        checked(self.api, unsafe {
            (self.api.token_count)(self.raw, &mut count)
        })?;

        Ok(count)
    }
}
