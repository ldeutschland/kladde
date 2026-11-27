use super::litert::{Conversation, Engine, Piece, Setup};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

const CHARACTERS_PER_TOKEN: usize = 3;
const MINIMUM_TOOL_TOKENS: usize = 120;
const TRUNCATED: &str = "\n[…]";
const TOOL_LIMIT: &str = "Tool limit reached. Answer the request now with what you found.";
const CONTEXT_FULL: &str = "Context almost full. Answer the request now with what you found.";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Parameter {
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub optional: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolPlan {
    pub name: String,
    pub description: String,
    pub parameters: Vec<Parameter>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub instructions: String,
    pub prompt: String,
    pub tools: Vec<ToolPlan>,
    pub temperature: f32,
    pub max_tool_calls: u32,
    pub tool_output_tokens: u32,
    pub answer_tokens: u32,
}

pub struct Host<'a> {
    pub show: &'a mut dyn FnMut(&str),
    pub tool: &'a mut dyn FnMut(&str, &Value) -> Result<String, String>,
    pub cancel: Arc<AtomicBool>,
    pub context: usize,
}

struct Call {
    name: String,
    arguments: Value,
}

fn tool_schema(plan: &ToolPlan) -> Value {
    let properties: serde_json::Map<String, Value> = plan
        .parameters
        .iter()
        .map(|parameter| {
            let schema = json!({"type": parameter.kind, "description": parameter.description});

            (parameter.name.clone(), schema)
        })
        .collect();
    let required: Vec<&str> = plan
        .parameters
        .iter()
        .filter(|parameter| !parameter.optional)
        .map(|parameter| parameter.name.as_str())
        .collect();
    let parameters = json!({"type": "object", "properties": properties, "required": required});

    json!({"type": "function", "function": {
        "name": plan.name,
        "description": plan.description,
        "parameters": parameters,
    }})
}

fn text_content(text: &str) -> Value {
    json!([{"type": "text", "text": text}])
}

fn user_message(text: &str) -> String {
    json!({"role": "user", "content": text_content(text)}).to_string()
}

fn chunk_text(chunk: &Value) -> String {
    chunk["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect()
}

fn chunk_calls(chunk: &Value) -> Vec<Call> {
    chunk["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|call| {
            let function = &call["function"];
            let name = function["name"].as_str()?.to_owned();
            let arguments = function["arguments"].clone();

            arguments.is_object().then_some(Call { name, arguments })
        })
        .collect()
}

fn failure(error: &str) -> String {
    let lowered = error.to_lowercase();
    let overflow = lowered.contains("token")
        && ["exceed", "too long", "max_num_tokens", "context"]
            .iter()
            .any(|sign| lowered.contains(sign));

    if overflow { "context" } else { "failed" }.into()
}

fn streamed(
    conversation: &mut Conversation,
    message: &str,
    request: &Request,
    host: &mut Host,
    answer: &mut String,
) -> Result<Vec<Call>, String> {
    let max_output = i32::try_from(request.answer_tokens).map_err(|_| "Invalid request")?;
    let pieces = conversation
        .send(message, max_output, host.cancel.clone())
        .map_err(|error| failure(&error))?;
    let mut calls = Vec::new();

    for piece in pieces {
        match piece {
            Piece::Text(raw) => {
                let chunk: Value = serde_json::from_str(&raw).map_err(|_| "failed")?;

                answer.push_str(&chunk_text(&chunk));
                (host.show)(answer);
                calls.extend(chunk_calls(&chunk));
            }
            Piece::Done => break,
            Piece::Failed(error) => return Err(failure(&error)),
        }
    }

    if host.cancel.load(Ordering::Acquire) {
        return Err("cancelled".into());
    }

    Ok(calls)
}

fn fitted(mut output: String, tokens: usize) -> String {
    let limit = tokens * CHARACTERS_PER_TOKEN;

    if output.chars().count() > limit {
        output = output.chars().take(limit).collect::<String>() + TRUNCATED;
    }

    output
}

struct Budget {
    calls: u32,
    room: usize,
}

fn tool_output(
    call: &Call,
    request: &Request,
    budget: &mut Budget,
    host: &mut Host,
) -> Result<String, String> {
    if budget.calls >= request.max_tool_calls {
        return Ok(TOOL_LIMIT.into());
    }

    let allowed = budget.room.min(request.tool_output_tokens as usize);

    if allowed < MINIMUM_TOOL_TOKENS {
        return Ok(CONTEXT_FULL.into());
    }

    budget.calls += 1;
    let output = fitted((host.tool)(&call.name, &call.arguments)?, allowed);

    budget.room = budget
        .room
        .saturating_sub(output.chars().count() / CHARACTERS_PER_TOKEN + 1);

    Ok(output)
}

fn responses(
    calls: &[Call],
    request: &Request,
    budget: &mut Budget,
    host: &mut Host,
) -> Result<String, String> {
    let content = calls
        .iter()
        .map(|call| {
            let output = tool_output(call, request, budget, host)?;

            Ok(json!({"type": "tool_response", "name": call.name, "response": output}))
        })
        .collect::<Result<Vec<Value>, String>>()?;

    Ok(json!({"role": "tool", "content": content}).to_string())
}

fn room(conversation: &Conversation, request: &Request, host: &Host) -> usize {
    let used = conversation.tokens().unwrap_or(host.context);

    host.context
        .saturating_sub(used)
        .saturating_sub(request.answer_tokens as usize)
}

pub fn answer(engine: &Engine, request: &Request, host: &mut Host) -> Result<String, String> {
    let tools: Vec<Value> = request.tools.iter().map(tool_schema).collect();
    let tools = if tools.is_empty() {
        String::new()
    } else {
        Value::from(tools).to_string()
    };

    let system = text_content(&request.instructions).to_string();
    let setup = Setup {
        system: &system,
        tools: &tools,
        temperature: request.temperature,
    };

    let mut conversation = engine
        .conversation(&setup)
        .map_err(|error| failure(&error))?;
    let mut message = user_message(&request.prompt);
    let mut budget = Budget {
        calls: 0,
        room: host.context,
    };

    let mut answer = String::new();

    loop {
        let calls = streamed(&mut conversation, &message, request, host, &mut answer)?;

        if calls.is_empty() {
            return Ok(answer);
        }

        budget.room = room(&conversation, request, host);
        message = responses(&calls, request, &mut budget, host)?;
    }
}
