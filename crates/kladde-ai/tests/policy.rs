use kladde_ai::{Error, Model, Policy, Turn, stream};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

const LIMITS: (f64, u64) = (0.5, 2_000_000);

fn policy() -> Policy {
    Policy {
        enabled: true,
        model: "anbieter/modell".into(),
        ..Policy::default()
    }
}

fn model() -> Model {
    Model {
        id: "anbieter/modell".into(),
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

fn user(text: &str) -> Value {
    json!({"role": "user", "content": text})
}

fn function_tool(name: &str) -> Value {
    json!({"type": "function", "function": {"name": name, "parameters": {}}})
}

fn refusal(policy: &Policy, model: &Model, turn: Turn, limits: (f64, u64)) -> Error {
    let cancel = CancellationToken::new();
    let key = Zeroizing::new(String::from("kein-echter-schluessel"));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    cancel.cancel();
    runtime
        .block_on(stream(
            &key,
            policy,
            model,
            turn,
            limits,
            cancel,
            |_| Ok(()),
        ))
        .unwrap_err()
}

fn refused(policy: &Policy, model: &Model, turn: Turn, limits: (f64, u64)) -> bool {
    matches!(refusal(policy, model, turn, limits), Error::Policy)
}

#[test]
fn the_default_policy_keeps_ai_off_and_retention_denied() {
    let policy = Policy::default();

    assert!(!policy.enabled);
    assert!(policy.zdr);
    assert!(!policy.web_search);
    assert!(policy.validate().is_ok());
    assert!(refused(
        &policy,
        &model(),
        turn(vec![user("hallo")]),
        LIMITS
    ));
}

#[test]
fn policy_bounds_are_validated() {
    let valid = |change: fn(&mut Policy)| {
        let mut policy = policy();

        change(&mut policy);

        policy.validate().is_ok()
    };

    assert!(valid(|p| p.budget = 50.0));
    assert!(valid(|p| p.steps = 100));
    assert!(valid(|p| p.model = "m".repeat(200)));

    let invalid: [fn(&mut Policy); 9] = [
        |p| p.budget = 0.0,
        |p| p.budget = -1.0,
        |p| p.budget = 50.01,
        |p| p.budget = f64::NAN,
        |p| p.budget = f64::INFINITY,
        |p| p.steps = 0,
        |p| p.steps = 101,
        |p| p.model = "m".repeat(201),
        |p| p.model = "anbieter/modell:online".into(),
    ];

    for change in invalid {
        assert!(!valid(change));
    }
}

#[test]
fn stored_policies_refuse_unknown_or_missing_fields() {
    let stored = json!({"enabled": true, "zdr": true, "model": "m", "budget": 1.0, "steps": 5});
    let parsed: Policy = serde_json::from_value(stored.clone()).unwrap();

    assert!(!parsed.web_search);
    let mut extra = stored.clone();

    extra["provider"] = json!({"data_collection": "allow"});
    assert!(serde_json::from_value::<Policy>(extra).is_err());
    let mut missing = stored.clone();

    missing.as_object_mut().unwrap().remove("zdr");
    assert!(serde_json::from_value::<Policy>(missing).is_err());
    let mut wrong_type = stored;

    wrong_type["budget"] = json!("1.0");
    assert!(serde_json::from_value::<Policy>(wrong_type).is_err());
    let parsed: Turn = serde_json::from_value(json!({"messages": [], "tools": []})).unwrap();

    assert!(!parsed.web_search);
}

#[test]
fn turns_outside_the_policy_are_refused_before_any_request() {
    let disabled = Policy {
        enabled: false,
        ..policy()
    };

    assert!(refused(&disabled, &model(), turn(vec![user("x")]), LIMITS));
    let other = Model {
        id: "anderer/anbieter".into(),
        ..model()
    };

    assert!(refused(&policy(), &other, turn(vec![user("x")]), LIMITS));
    assert!(refused(&policy(), &model(), turn(vec![]), LIMITS));
    assert!(refused(
        &policy(),
        &model(),
        turn(vec![user("x"); 321]),
        LIMITS
    ));
    let searching = Turn {
        web_search: true,
        ..turn(vec![user("x")])
    };

    assert!(refused(&policy(), &model(), searching, LIMITS));
    let smuggled = Turn {
        tools: vec![json!({"type": "openrouter:web_search", "parameters": {"max_uses": 99}})],
        ..turn(vec![user("x")])
    };

    assert!(refused(&policy(), &model(), smuggled, LIMITS));
    let crowded = Turn {
        tools: (0..23).map(|i| function_tool(&format!("t{i}"))).collect(),
        ..turn(vec![user("x")])
    };

    assert!(matches!(
        refusal(&policy(), &model(), crowded, LIMITS),
        Error::TooManyTools
    ));
}

#[test]
fn messages_with_foreign_fields_roles_or_content_are_refused() {
    let call =
        json!([{"id": "a", "type": "function", "function": {"name": "x", "arguments": "{}"}}]);

    for message in [
        json!({"role": "user", "content": "x", "name": "admin"}),
        json!({"role": "user", "content": "x", "provider": {"zdr": false}}),
        json!({"role": "developer", "content": "x"}),
        json!({"role": "function", "content": "x"}),
        json!({"content": "x"}),
        json!({"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}]}),
        json!({"role": "user", "content": null}),
        json!({"role": "user", "content": null, "tool_calls": call}),
        json!({"role": "assistant", "content": "x", "reasoning_details": [{"text": "r".repeat(200_001)}]}),
        json!({"role": "assistant", "content": "x", "reasoning_details": {"text": "r"}}),
        json!("user: x"),
        json!(null),
    ] {
        assert!(
            refused(
                &policy(),
                &model(),
                turn(vec![user("ok"), message.clone()]),
                LIMITS
            ),
            "{message}"
        );
    }
}

#[test]
fn budgets_and_request_sizes_are_enforced_before_any_request() {
    for remaining in [0.0, -0.1, 0.51, f64::NAN, f64::INFINITY] {
        assert!(
            refused(
                &policy(),
                &model(),
                turn(vec![user("x")]),
                (remaining, 2_000_000)
            ),
            "{remaining}"
        );
    }

    assert!(refused(
        &policy(),
        &model(),
        turn(vec![user("x")]),
        (0.5, 100)
    ));
    assert!(refused(
        &policy(),
        &model(),
        turn(vec![user(&"a".repeat(512_001))]),
        LIMITS
    ));
    let expensive = Model {
        prompt: 0.01,
        ..model()
    };

    assert!(refused(
        &policy(),
        &expensive,
        turn(vec![user("x")]),
        LIMITS
    ));
    let invalid = Policy {
        budget: 0.0,
        ..policy()
    };

    assert!(refused(
        &invalid,
        &model(),
        turn(vec![user("x")]),
        (0.1, 2_000_000)
    ));
}
