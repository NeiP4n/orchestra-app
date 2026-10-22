use async_stream::stream;
use futures::StreamExt;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User { text: String },
    Assistant { text: String, calls: Vec<ToolCall> },
    Tool { id: String, output: String },
}

/// What a model is told about a tool. `schema` is a JSON Schema document for the input.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: String,
}

#[derive(Clone, Debug, Default)]
pub struct Request {
    pub messages: Vec<Message>,
    pub system: Option<String>,
    pub tools: Vec<ToolSpec>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Chunk {
    Text(String),
    Call(ToolCall),
}

/// Why a transport failed decides what the pool and the loop do next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    RateLimit,
    Unavailable,
    ContextOverflow,
    Fatal,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TransportError {
    pub message: String,
    pub kind: ErrorKind,
    /// Only meaningful for rate limits: how long the transport should rest.
    pub retry_after: Option<Duration>,
}

impl TransportError {
    pub fn new(message: impl Into<String>, kind: ErrorKind) -> Self {
        Self { message: message.into(), kind, retry_after: None }
    }

    pub fn retry_after(mut self, after: Duration) -> Self {
        self.retry_after = Some(after);
        self
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TransportError {}

/// Any lawful way of getting a model answer: an API key, a signed-in subscription, a shared quota
/// of a peer, a local runtime, or a person. The kernel never asks which.
pub trait Transport: Send + Sync {
    fn id(&self) -> String;
    fn send(
        &self,
        request: Request,
        cancel: CancellationToken,
    ) -> BoxStream<'static, Result<Chunk, TransportError>>;
}

const DEFAULT_REST: Duration = Duration::from_secs(30);

/// Ordered failover over transports. A rate-limited or unavailable transport rests for a while and
/// the next one answers, so a quota running out never ends a session.
pub struct Pool {
    transports: Vec<Arc<dyn Transport>>,
    resting: Arc<Mutex<HashMap<String, Instant>>>,
}

impl Pool {
    pub fn new(transports: Vec<Arc<dyn Transport>>) -> Self {
        Self { transports, resting: Arc::default() }
    }
}

impl Transport for Pool {
    fn id(&self) -> String {
        let ids: Vec<String> = self.transports.iter().map(|transport| transport.id()).collect();
        format!("pool({})", ids.join(","))
    }

    fn send(
        &self,
        request: Request,
        cancel: CancellationToken,
    ) -> BoxStream<'static, Result<Chunk, TransportError>> {
        let transports = self.transports.clone();
        let resting = self.resting.clone();
        Box::pin(stream! {
            let mut failures: Vec<TransportError> = Vec::new();
            for transport in transports {
                let id = transport.id();
                let until = resting.lock().unwrap().get(&id).copied();
                if until.is_some_and(|until| until > Instant::now()) {
                    continue;
                }
                let mut emitted = false;
                let mut chunks = transport.send(request.clone(), cancel.clone());
                let mut failure = None;
                while let Some(chunk) = chunks.next().await {
                    match chunk {
                        Ok(chunk) => {
                            emitted = true;
                            yield Ok(chunk);
                        }
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    }
                }
                let Some(error) = failure else { return };
                // Once output reached the caller, switching transports would duplicate or splice answers.
                if emitted || matches!(error.kind, ErrorKind::Fatal | ErrorKind::ContextOverflow) {
                    yield Err(error);
                    return;
                }
                resting
                    .lock()
                    .unwrap()
                    .insert(id, Instant::now() + error.retry_after.unwrap_or(DEFAULT_REST));
                failures.push(error);
            }
            let now = Instant::now();
            let soonest = resting
                .lock()
                .unwrap()
                .values()
                .map(|until| until.saturating_duration_since(now))
                .min()
                .map_or(DEFAULT_REST, |rest| rest.min(DEFAULT_REST));
            let message = if failures.is_empty() {
                "every transport is resting".to_string()
            } else {
                failures.iter().map(|failure| failure.message.clone()).collect::<Vec<_>>().join("; ")
            };
            yield Err(TransportError::new(message, ErrorKind::Unavailable).retry_after(soonest));
        })
    }
}
