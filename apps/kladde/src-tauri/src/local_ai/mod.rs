mod agent;
mod litert;
pub mod models;

use crate::{ai::policy, notebook::vault::Vault};

use agent::{Host, Request, ToolPlan};
use kladde_ai::Provider;
use litert::{Engine, Load};
use models::LocalModel;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, State, ipc::Channel};
use uuid::Uuid;

pub use models::Downloads;

pub const SUPPORTED: bool = cfg!(target_os = "ios");
const CONTEXT: usize = 8192;
const BACKENDS: [&str; 2] = ["gpu", "cpu"];
const LIBRARY: &str = "Frameworks/CLiteRTLM.framework/CLiteRTLM";
const CACHE: &str = "litert";
const TOOL_WAIT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(100);
const MAX_INSTRUCTIONS: usize = 24_000;
const MAX_PROMPT: usize = 64_000;
const MAX_TOOLS: usize = 8;
const MAX_PARAMETERS: usize = 6;
const MAX_NAME: usize = 32;
const MAX_DESCRIPTION: usize = 600;
const MAX_TOOL_CALLS: u32 = 12;
const MAX_OUTPUT: usize = 48_000;
const MAX_GENERATIONS: u32 = 4;
const PARAMETER_TYPES: [&str; 2] = ["string", "integer"];
const INVALID: &str = "Invalid request";
const UNKNOWN_RUN: &str = "Unknown run";
const CANCELLED: &str = "cancelled";

struct Loaded {
    model: &'static str,
    engine: Engine,
}

static ENGINE: Mutex<Option<Loaded>> = Mutex::new(None);

#[cfg(target_os = "ios")]
pub fn release() {
    if let Ok(mut slot) = ENGINE.try_lock() {
        *slot = None;
    }
}

fn release_model(id: &str) {
    if let Ok(mut slot) = ENGINE.try_lock()
        && slot.as_ref().is_some_and(|loaded| loaded.model == id)
    {
        *slot = None;
    }
}

#[derive(Serialize)]
pub struct LocalStatus {
    available: bool,
    reason: &'static str,
    context: usize,
}

fn smallest_fits() -> bool {
    models::MODELS.iter().any(models::fits_device)
}

#[tauri::command]
pub fn local_ai_status() -> LocalStatus {
    let reason = match (SUPPORTED, smallest_fits()) {
        (false, _) => "platform",
        (true, false) => "device",
        (true, true) => "",
    };

    LocalStatus {
        available: reason.is_empty(),
        reason,
        context: CONTEXT,
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

fn valid_description(text: &str) -> bool {
    text.len() <= MAX_DESCRIPTION && !text.chars().any(char::is_control)
}

fn valid_tool(tool: &ToolPlan) -> bool {
    let names: HashSet<&str> = tool.parameters.iter().map(|p| p.name.as_str()).collect();

    valid_name(&tool.name)
        && valid_description(&tool.description)
        && tool.parameters.len() <= MAX_PARAMETERS
        && names.len() == tool.parameters.len()
        && tool.parameters.iter().all(|p| {
            valid_name(&p.name)
                && valid_description(&p.description)
                && PARAMETER_TYPES.contains(&p.kind.as_str())
        })
}

fn validate(request: &Request) -> Result<(), String> {
    let names: HashSet<&str> = request.tools.iter().map(|t| t.name.as_str()).collect();
    let valid = request.instructions.len() <= MAX_INSTRUCTIONS
        && !request.prompt.trim().is_empty()
        && request.prompt.len() <= MAX_PROMPT
        && request.tools.len() <= MAX_TOOLS
        && names.len() == request.tools.len()
        && request.tools.iter().all(valid_tool)
        && (0.0..=1.0).contains(&request.temperature)
        && request.max_tool_calls <= MAX_TOOL_CALLS
        && (1..=CONTEXT as u32).contains(&request.tool_output_tokens)
        && (1..CONTEXT as u32).contains(&request.answer_tokens);

    if valid { Ok(()) } else { Err(INVALID.into()) }
}

struct Run {
    space: Uuid,
    model: &'static str,
    cancel: Arc<AtomicBool>,
    busy: bool,
    generations: u32,
    calls: HashMap<String, Sender<String>>,
}

#[derive(Default)]
pub struct LocalRuns(Mutex<HashMap<Uuid, Run>>);

impl LocalRuns {
    fn runs(&self) -> Result<MutexGuard<'_, HashMap<Uuid, Run>>, String> {
        self.0.lock().map_err(|_| "AI".into())
    }

    fn begin(&self, id: Uuid) -> Result<(&'static str, Arc<AtomicBool>), String> {
        let mut runs = self.runs()?;
        let run = runs.get_mut(&id).ok_or(UNKNOWN_RUN)?;

        if run.busy || run.generations >= MAX_GENERATIONS {
            return Err("busy".into());
        }

        run.busy = true;
        run.generations += 1;

        Ok((run.model, run.cancel.clone()))
    }

    fn end(&self, id: Uuid) {
        if let Ok(mut runs) = self.runs()
            && let Some(run) = runs.get_mut(&id)
        {
            run.busy = false;
            run.calls.clear();
        }
    }

    fn wait_for(&self, id: Uuid, call: &str) -> Result<mpsc::Receiver<String>, String> {
        let (sender, receiver) = mpsc::channel();
        let mut runs = self.runs()?;
        let run = runs.get_mut(&id).ok_or(CANCELLED)?;

        run.calls.insert(call.to_owned(), sender);

        Ok(receiver)
    }

    fn answer(&self, id: Uuid, call: &str, output: String) -> Result<(), String> {
        let sender = self
            .runs()?
            .get_mut(&id)
            .and_then(|run| run.calls.remove(call))
            .ok_or("Unknown tool call")?;
        let _ = sender.send(output);

        Ok(())
    }

    fn remove(&self, id: Uuid) {
        if let Ok(mut runs) = self.runs()
            && let Some(run) = runs.remove(&id)
        {
            run.cancel.store(true, Ordering::Release);
        }
    }

    pub fn cancel_space(&self, space: Uuid) {
        if let Ok(mut runs) = self.runs() {
            runs.retain(|_, run| {
                let keep = run.space != space;

                if !keep {
                    run.cancel.store(true, Ordering::Release);
                }

                keep
            });
        }
    }
}

fn library() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "unavailable")?;

    Ok(exe.parent().ok_or("unavailable")?.join(LIBRARY))
}

fn cache_folder(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|_| "storage")?
        .join(CACHE))
}

fn load(app: &AppHandle, model: &'static LocalModel) -> Result<Engine, String> {
    let path = models::installed(app, model).ok_or("missing")?;
    let cache = cache_folder(app)?;
    let library = library()?;

    std::fs::create_dir_all(&cache).map_err(|_| "storage")?;
    let mut failure = String::from("unavailable");

    for backend in BACKENDS {
        let load = Load {
            library: &library,
            model: &path,
            backend,
            max_tokens: CONTEXT as i32,
            cache: &cache,
        };

        match Engine::load(&load) {
            Ok(engine) => return Ok(engine),
            Err(error) => failure = error,
        }
    }

    eprintln!("Local model unavailable: {failure}");

    Err("unavailable".into())
}

fn engine_slot() -> Result<MutexGuard<'static, Option<Loaded>>, String> {
    match ENGINE.try_lock() {
        Ok(slot) => Ok(slot),
        Err(TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => Err("busy".into()),
    }
}

struct Generation {
    app: AppHandle,
    run: Uuid,
    model: &'static LocalModel,
    request: Request,
    channel: Channel<Value>,
    cancel: Arc<AtomicBool>,
}

fn tool_output(
    generation: &Generation,
    call: &str,
    name: &str,
    arguments: &Value,
) -> Result<String, String> {
    let runs = generation.app.state::<LocalRuns>();
    let receiver = runs.wait_for(generation.run, call)?;
    let event =
        json!({"kind": "tool", "call": call, "name": name, "arguments": arguments.to_string()});
    let asked = Instant::now();

    generation.channel.send(event).map_err(|_| CANCELLED)?;

    loop {
        match receiver.recv_timeout(POLL) {
            Ok(output) => return Ok(output),
            Err(RecvTimeoutError::Disconnected) => return Err(CANCELLED.into()),
            Err(RecvTimeoutError::Timeout) if generation.cancel.load(Ordering::Acquire) => {
                return Err(CANCELLED.into());
            }
            Err(RecvTimeoutError::Timeout) if asked.elapsed() > TOOL_WAIT => {
                return Err("failed".into());
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn generate(generation: Generation) -> Result<(), String> {
    let mut slot = engine_slot()?;

    if slot
        .as_ref()
        .is_none_or(|loaded| loaded.model != generation.model.id)
    {
        *slot = None;
        *slot = Some(Loaded {
            model: generation.model.id,
            engine: load(&generation.app, generation.model)?,
        });
    }

    let engine = &slot.as_ref().ok_or("unavailable")?.engine;
    let mut sent = 0;
    let mut calls = 0;
    let mut show = |answer: &str| {
        if answer.len() > sent && answer.is_char_boundary(sent) {
            let _ = generation
                .channel
                .send(json!({"kind": "text", "text": &answer[sent..]}));
            sent = answer.len();
        }
    };

    let mut tool = |name: &str, arguments: &Value| {
        calls += 1;

        tool_output(&generation, &format!("c{calls}"), name, arguments)
    };

    let mut host = Host {
        show: &mut show,
        tool: &mut tool,
        cancel: generation.cancel.clone(),
        context: CONTEXT,
    };

    agent::answer(engine, &generation.request, &mut host).map(|_| ())
}

#[tauri::command]
pub fn local_ai_start(
    app: AppHandle,
    vault: State<Vault>,
    runs: State<LocalRuns>,
    space: Uuid,
) -> Result<Uuid, String> {
    let settings = policy(&app, &vault, space)?;

    if !settings.enabled || settings.provider != Provider::Local {
        return Err("AI disabled".into());
    }

    let model = models::model(&settings.model).map_err(|_| "missing")?;

    if !SUPPORTED || models::installed(&app, model).is_none() {
        return Err("missing".into());
    }

    let mut active = runs.runs()?;

    if active.values().any(|run| run.space == space) {
        return Err("Run already active".into());
    }

    let id = Uuid::new_v4();

    active.insert(
        id,
        Run {
            space,
            model: model.id,
            cancel: Arc::new(AtomicBool::new(false)),
            busy: false,
            generations: 0,
            calls: HashMap::new(),
        },
    );

    Ok(id)
}

#[tauri::command]
pub async fn local_ai_run(
    app: AppHandle,
    runs: State<'_, LocalRuns>,
    run: Uuid,
    request: Request,
    channel: Channel<Value>,
) -> Result<(), String> {
    validate(&request)?;
    let (model, cancel) = runs.begin(run)?;
    let generation = Generation {
        app: app.clone(),
        run,
        model: models::model(model)?,
        request,
        channel,
        cancel,
    };

    let result = tauri::async_runtime::spawn_blocking(move || generate(generation))
        .await
        .map_err(|_| "failed")?;

    runs.end(run);

    result
}

fn clipped(mut text: String) -> String {
    text.retain(|c| c != '\0');

    if text.len() > MAX_OUTPUT {
        let end = (0..=MAX_OUTPUT)
            .rev()
            .find(|i| text.is_char_boundary(*i))
            .unwrap_or_default();

        text.truncate(end);
    }

    text
}

#[tauri::command]
pub fn local_ai_tool_result(
    runs: State<LocalRuns>,
    run: Uuid,
    call: String,
    output: String,
) -> Result<(), String> {
    runs.answer(run, &call, clipped(output))
}

#[tauri::command]
pub fn local_ai_stop(runs: State<LocalRuns>, run: Uuid) -> Result<(), String> {
    runs.remove(run);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent::Parameter;

    fn request() -> Request {
        Request {
            instructions: "Be helpful.".into(),
            prompt: "Hallo".into(),
            tools: vec![ToolPlan {
                name: "search".into(),
                description: "Search notes".into(),
                parameters: vec![Parameter {
                    name: "query".into(),
                    description: "Keywords".into(),
                    kind: "string".into(),
                    optional: false,
                }],
            }],
            temperature: 0.2,
            max_tool_calls: 6,
            tool_output_tokens: 600,
            answer_tokens: 1200,
        }
    }

    #[test]
    fn requests_are_checked_at_the_boundary() {
        assert!(validate(&request()).is_ok());

        let mut bad_name = request();

        bad_name.tools[0].name = "search; rm".into();
        assert!(validate(&bad_name).is_err());

        let mut bad_type = request();

        bad_type.tools[0].parameters[0].kind = "object".into();
        assert!(validate(&bad_type).is_err());

        let mut duplicate = request();

        duplicate.tools.push(ToolPlan {
            name: "search".into(),
            description: String::new(),
            parameters: vec![],
        });
        assert!(validate(&duplicate).is_err());

        let mut empty = request();

        empty.prompt = "  ".into();
        assert!(validate(&empty).is_err());

        let mut hot = request();

        hot.temperature = 1.5;
        assert!(validate(&hot).is_err());

        let mut greedy = request();

        greedy.answer_tokens = CONTEXT as u32;
        assert!(validate(&greedy).is_err());
    }

    #[test]
    fn tool_output_is_clipped_on_a_char_boundary() {
        let clipped = clipped("ä".repeat(MAX_OUTPUT) + "\0");

        assert!(clipped.len() <= MAX_OUTPUT);
        assert!(!clipped.contains('\0'));
    }

    #[test]
    fn tool_results_need_a_waiting_call() {
        let runs = LocalRuns::default();
        let id = Uuid::new_v4();

        runs.runs().unwrap().insert(
            id,
            Run {
                space: Uuid::new_v4(),
                model: "gemma-4-e2b",
                cancel: Arc::new(AtomicBool::new(false)),
                busy: true,
                generations: 1,
                calls: HashMap::new(),
            },
        );
        let receiver = runs.wait_for(id, "c1").unwrap();

        assert!(runs.answer(id, "c2", "x".into()).is_err());
        assert!(runs.answer(id, "c1", "ok".into()).is_ok());
        assert_eq!(receiver.recv().unwrap(), "ok");
        assert!(runs.answer(id, "c1", "again".into()).is_err());
    }
}
