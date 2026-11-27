use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Request rejected by privacy or budget policy")]
    Policy,
    #[error("Request exceeds the limit of {MAX_FUNCTION_TOOLS} function tools")]
    TooManyTools,
    #[error("OpenRouter unavailable")]
    Network,
    #[error("Invalid or incomplete provider response")]
    Response,
    #[error("Cancelled")]
    Cancelled,
    #[error("Provider error: {0}")]
    Provider(String),
}

const MAX_OUTPUT_TOKENS: f64 = 16_384.;
const MAX_FUNCTION_TOOLS: usize = 22;
const MAX_REASONING_BYTES: usize = 200_000;
const PROVIDER_MESSAGE_LENGTH: usize = 300;
const RETRY_DELAY_MS: u64 = 400;
const MAX_RETRIES: u64 = 2;

fn provider_message(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    let raw = error["message"].as_str().or_else(|| error.as_str())?;
    let clean: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(PROVIDER_MESSAGE_LENGTH)
        .collect();
    let clean = clean.trim();

    (!clean.is_empty()).then(|| clean.to_string())
}

fn retryable(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS
        || status == StatusCode::BAD_GATEWAY
        || status == StatusCode::SERVICE_UNAVAILABLE
        || status == StatusCode::GATEWAY_TIMEOUT
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub prompt: f64,
    pub completion: f64,
    pub request: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Openrouter,
    Local,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub enabled: bool,
    pub zdr: bool,
    #[serde(default)]
    pub web_search: bool,
    #[serde(default)]
    pub provider: Provider,
    pub model: String,
    pub budget: f64,
    pub steps: u32,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            enabled: false,
            zdr: true,
            web_search: false,
            provider: Provider::Openrouter,
            model: String::new(),
            budget: 0.5,
            steps: 25,
        }
    }
}

impl Policy {
    pub fn validate(&self) -> Result<(), Error> {
        if self.model.len() > 200
            || self.model.ends_with(":online")
            || !self.budget.is_finite()
            || self.budget <= 0.0
            || self.budget > 50.0
            || self.steps == 0
            || self.steps > 100
            || (self.provider == Provider::Local && self.web_search)
        {
            return Err(Error::Policy);
        }

        Ok(())
    }

    pub fn uses_openrouter(&self) -> bool {
        self.enabled && self.provider == Provider::Openrouter
    }
}

pub fn client() -> Result<Client, Error> {
    Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| Error::Network)
}

async fn limited(response: Response) -> Result<Vec<u8>, Error> {
    let mut out = vec![];
    let mut stream = response.bytes_stream();

    while let Some(part) = stream.next().await {
        let bytes = part.map_err(|_| Error::Network)?;

        if bytes.len() + out.len() > 8_000_000 {
            return Err(Error::Response);
        }

        out.extend(bytes)
    }

    Ok(out)
}

pub async fn models(client: &Client) -> Result<Vec<Model>, Error> {
    let response = client
        .get("https://openrouter.ai/api/v1/models?supported_parameters=tools")
        .send()
        .await
        .map_err(|_| Error::Network)?
        .error_for_status()
        .map_err(|_| Error::Network)?;
    let json: Value =
        serde_json::from_slice(&limited(response).await?).map_err(|_| Error::Response)?;
    let mut out = vec![];

    for m in json["data"].as_array().ok_or(Error::Response)? {
        if !m["supported_parameters"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x == "tools"))
        {
            continue;
        }

        let price = |k: &str| {
            m["pricing"][k]
                .as_str()?
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && *v >= 0.)
        };

        let (Some(id), Some(prompt), Some(completion)) =
            (m["id"].as_str(), price("prompt"), price("completion"))
        else {
            continue;
        };

        if id.is_empty() || id.len() > 200 {
            continue;
        }

        out.push(Model {
            id: id.into(),
            prompt,
            completion,
            request: price("request").unwrap_or(0.),
        });
    }

    Ok(out)
}

#[derive(Serialize, Deserialize)]
pub struct Turn {
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    #[serde(default)]
    pub web_search: bool,
}

const MAX_MESSAGES: usize = 320;
const MAX_REQUEST_BYTES: usize = 512_000;
const TOKENS_PER_ITEM: f64 = 64.;
const PROMPT_OVERHEAD_TOKENS: f64 = 512.;
const ALLOWED_MESSAGE_FIELDS: [&str; 5] = [
    "role",
    "content",
    "tool_calls",
    "tool_call_id",
    "reasoning_details",
];

fn check_turn(policy: &Policy, model: &Model, turn: &Turn, remaining: f64) -> Result<(), Error> {
    policy.validate()?;

    if turn.tools.len() > MAX_FUNCTION_TOOLS {
        return Err(Error::TooManyTools);
    }

    if !policy.uses_openrouter()
        || model.id != policy.model
        || !remaining.is_finite()
        || remaining <= 0.
        || remaining > policy.budget
        || turn.messages.is_empty()
        || turn.messages.len() > MAX_MESSAGES
        || turn.tools.iter().any(|tool| tool["type"] != "function")
        || (turn.web_search && !policy.web_search)
    {
        return Err(Error::Policy);
    }

    turn.messages.iter().try_for_each(check_message)
}

fn check_message(message: &Value) -> Result<(), Error> {
    let fields = message.as_object().ok_or(Error::Policy)?;

    if fields
        .keys()
        .any(|key| !ALLOWED_MESSAGE_FIELDS.contains(&key.as_str()))
    {
        return Err(Error::Policy);
    }

    if let Some(details) = fields.get("reasoning_details") {
        let valid = message["role"] == "assistant"
            && details
                .as_array()
                .is_some_and(|entries| entries.iter().all(Value::is_object))
            && details.to_string().len() <= MAX_REASONING_BYTES;
        if !valid {
            return Err(Error::Policy);
        }
    }

    match message["role"].as_str() {
        Some("assistant") if message["content"].is_null() && message["tool_calls"].is_array() => {
            Ok(())
        }
        Some("system" | "user" | "assistant" | "tool") if message["content"].is_string() => Ok(()),
        _ => Err(Error::Policy),
    }
}

fn web_search_tool() -> Value {
    json!({
        "type": "openrouter:web_search",
        "parameters": {
            "engine": "exa", "mode": "fast", "max_uses": 1,
            "max_results": 3, "max_total_results": 3, "max_characters": 900
        }
    })
}

fn search_costs(web_search: bool) -> (f64, f64, f64) {
    if web_search {
        (2., 0.007, 16_384.)
    } else {
        (1., 0., 0.)
    }
}

fn max_output_tokens(model: &Model, turn: &Turn, limits: (f64, u64)) -> Result<u32, Error> {
    let (remaining, tokens_left) = limits;
    let bytes = serde_json::to_vec(&(&turn.messages, &turn.tools))
        .map_err(|_| Error::Policy)?
        .len();
    if bytes > MAX_REQUEST_BYTES {
        return Err(Error::Policy);
    }

    let items = (turn.messages.len() + turn.tools.len()) as f64;
    let prompt_bound = bytes as f64 + TOKENS_PER_ITEM * items + PROMPT_OVERHEAD_TOKENS;
    let (passes, search_fee, search_context) = search_costs(turn.web_search);
    let input_bound = passes * prompt_bound + search_context;
    let available = remaining - passes * model.request - search_fee - input_bound * model.prompt;

    if available <= 0. || input_bound >= tokens_left as f64 {
        return Err(Error::Policy);
    }

    let output_price = passes * model.completion + (passes - 1.) * model.prompt;
    let affordable = if output_price == 0. {
        MAX_OUTPUT_TOKENS as u32
    } else {
        (available / output_price).floor().min(MAX_OUTPUT_TOKENS) as u32
    };

    let max_tokens =
        affordable.min(((tokens_left as f64 - input_bound) / (2. * passes - 1.)) as u32);
    if max_tokens < 1 {
        return Err(Error::Policy);
    }

    Ok(max_tokens)
}

fn provider_settings(policy: &Policy, model: &Model) -> Value {
    let mut provider = json!({"require_parameters":true,"max_price":{"prompt":model.prompt*1e6,"completion":model.completion*1e6,"request":model.request}});

    if policy.zdr {
        provider["zdr"] = json!(true);

        provider["data_collection"] = json!("deny")
    }

    provider
}

fn request_body(
    policy: &Policy,
    model: &Model,
    mut turn: Turn,
    limits: (f64, u64),
) -> Result<Value, Error> {
    check_turn(policy, model, &turn, limits.0)?;

    if turn.web_search {
        turn.tools.push(web_search_tool());
    }

    let max_tokens = max_output_tokens(model, &turn, limits)?;
    let provider = provider_settings(policy, model);
    let mut body = json!({"model":model.id,"messages":turn.messages,"provider":provider,"stream":true,"stream_options":{"include_usage":true},"max_tokens":max_tokens});

    body["plugins"] = json!([{"id":"web","enabled":false}]);

    if !turn.tools.is_empty() {
        body["tools"] = json!(turn.tools);
    }

    Ok(body)
}

const CHAT_COMPLETIONS: &str = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RESPONSE_BYTES: usize = 4_000_000;
const STREAM_DONE: &str = "[DONE]";

async fn post_with_retries(
    client: &Client,
    key: &str,
    body: &Value,
    cancel: &CancellationToken,
) -> Result<Response, Error> {
    let mut tries = 0;

    loop {
        let result = tokio::select! {_=cancel.cancelled()=>return Err(Error::Cancelled),r=client.post(CHAT_COMPLETIONS).bearer_auth(key).json(body).send()=>r.map_err(|_|Error::Network)?};
        let status = result.status();

        if retryable(status) && tries < MAX_RETRIES {
            tries += 1;
            tokio::select! {_=cancel.cancelled()=>return Err(Error::Cancelled),_=tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS*tries))=>{}}
            continue;
        }

        if status.is_success() {
            return Ok(result);
        }

        return Err(refusal(result).await);
    }
}

async fn refusal(response: Response) -> Error {
    let status = response.status();
    let body = limited(response).await.unwrap_or_default();
    let message = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|value| provider_message(&value));

    match message {
        Some(message) => Error::Provider(format!("{} ({})", message, status.as_u16())),
        None => Error::Network,
    }
}

fn usage_of(value: &Value) -> Result<Option<(f64, u64)>, Error> {
    if value.get("error").is_some() {
        return Err(provider_message(value).map_or(Error::Response, Error::Provider));
    }

    let Some(cost) = value["usage"]["cost"].as_f64() else {
        return Ok(None);
    };

    if !cost.is_finite() || cost < 0. {
        return Err(Error::Response);
    }

    let tokens = value["usage"]["total_tokens"]
        .as_u64()
        .ok_or(Error::Response)?;

    Ok(Some((cost, tokens)))
}

pub async fn stream(
    key: &Zeroizing<String>,
    policy: &Policy,
    model: &Model,
    turn: Turn,
    limits: (f64, u64),
    cancel: CancellationToken,
    mut send: impl FnMut(Value) -> Result<(), Error>,
) -> Result<(f64, u64), Error> {
    let body = request_body(policy, model, turn, limits)?;
    let client = client()?;
    let response = post_with_retries(&client, key.as_str(), &body, &cancel).await?;
    let mut events = response
        .bytes_stream()
        .scan(0usize, |received, chunk| {
            let item = chunk.map_err(|_| Error::Network).and_then(|part| {
                *received += part.len();

                if *received > MAX_RESPONSE_BYTES {
                    Err(Error::Response)
                } else {
                    Ok(part)
                }
            });

            std::future::ready(Some(item))
        })
        .eventsource();
    let mut usage = None;

    loop {
        let event =
            tokio::select! {_=cancel.cancelled()=>return Err(Error::Cancelled),v=events.next()=>v};
        let event = event.ok_or(Error::Response)?.map_err(|_| Error::Response)?;

        if event.data == STREAM_DONE {
            return usage.ok_or(Error::Response);
        }

        let value: Value = serde_json::from_str(&event.data).map_err(|_| Error::Response)?;

        if let Some(reported) = usage_of(&value)? {
            usage = Some(reported)
        }

        send(value)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy {
            enabled: true,
            model: "m".into(),
            ..Policy::default()
        }
    }

    fn model() -> Model {
        Model {
            id: "m".into(),
            prompt: 0.,
            completion: 0.,
            request: 0.,
        }
    }

    fn turn(messages: Vec<Value>) -> Turn {
        Turn {
            messages,
            tools: vec![],
            web_search: false,
        }
    }

    #[test]
    fn provider_messages_are_cleaned_and_limited() {
        let value = json!({"error": {"message": "No endpoints\nfound ".repeat(100)}});
        let message = provider_message(&value).unwrap();

        assert!(message.len() <= PROVIDER_MESSAGE_LENGTH);
        assert!(!message.contains('\n'));
        assert_eq!(provider_message(&json!({"error": {"code": 1}})), None);
    }

    #[test]
    fn free_models_get_room_for_reasoning() {
        let body = request_body(
            &policy(),
            &model(),
            turn(vec![json!({"role": "user", "content": "hi"})]),
            (0.5, 2_000_000),
        )
        .unwrap();

        assert_eq!(body["max_tokens"], MAX_OUTPUT_TOKENS as u32);
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn reasoning_details_only_on_assistant_messages() {
        let call =
            json!([{"id": "a", "type": "function", "function": {"name": "x", "arguments": "{}"}}]);
        let assistant = json!({"role": "assistant", "content": null, "tool_calls": call, "reasoning_details": [{"type": "reasoning.text", "text": "t"}]});

        assert!(request_body(&policy(), &model(), turn(vec![assistant]), (0.5, 2_000_000)).is_ok());
        let user = json!({"role": "user", "content": "x", "reasoning_details": []});

        assert!(request_body(&policy(), &model(), turn(vec![user]), (0.5, 2_000_000)).is_err());
        let malformed = json!({"role": "assistant", "content": "x", "reasoning_details": ["text"]});

        assert!(
            request_body(&policy(), &model(), turn(vec![malformed]), (0.5, 2_000_000)).is_err()
        );
    }
}
