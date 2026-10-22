use crate::transport::{Chunk, ErrorKind, Message, Request, ToolCall, ToolSpec, Transport, TransportError};
use async_stream::stream;
use futures::StreamExt;
use futures::future::{BoxFuture, join_all};
use futures::stream::BoxStream;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn spec(&self) -> ToolSpec {
        ToolSpec { name: self.name().to_string(), description: String::new(), schema: "{\"type\":\"object\"}".to_string() }
    }
    fn run(&self, input: String, cancel: CancellationToken) -> BoxFuture<'static, Result<String, String>>;
}

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Text(String),
    Call(ToolCall),
    /// The complete answer of one step, emitted before its tools run so callers can persist it.
    Assistant { text: String, calls: Vec<ToolCall> },
    Result { id: String, output: String },
    Wait { ms: u64, reason: String },
    Done(Vec<Message>),
}

/// Shrinks history after a context overflow; without one the overflow is fatal.
pub type Compact = Arc<dyn Fn(Vec<Message>) -> BoxFuture<'static, Vec<Message>> + Send + Sync>;

pub struct Options {
    pub transport: Arc<dyn Transport>,
    pub tools: Vec<Arc<dyn Tool>>,
    pub messages: Vec<Message>,
    pub system: Option<String>,
    pub cancel: CancellationToken,
    pub compact: Option<Compact>,
}

const DEFAULT_WAIT: Duration = Duration::from_secs(1);

/// The agent loop. It has no step ceiling: it ends when the model stops calling tools, the token
/// is cancelled, or a failure is fatal. Rate limits wait and retry, overflow compacts and retries,
/// and the tool calls of one answer run in parallel.
pub fn run(options: Options) -> BoxStream<'static, Result<Event, TransportError>> {
    Box::pin(stream! {
        let Options { transport, tools, mut messages, system, cancel, compact } = options;
        let specs: Vec<ToolSpec> = tools.iter().map(|tool| tool.spec()).collect();
        let tools: HashMap<String, Arc<dyn Tool>> =
            tools.into_iter().map(|tool| (tool.name().to_string(), tool)).collect();

        while !cancel.is_cancelled() {
            let mut text = String::new();
            let mut calls: Vec<ToolCall> = Vec::new();
            let mut failure = None;
            let mut chunks = transport.send(
                Request { messages: messages.clone(), system: system.clone(), tools: specs.clone() },
                cancel.clone(),
            );
            while let Some(chunk) = chunks.next().await {
                match chunk {
                    Ok(Chunk::Text(delta)) => {
                        text.push_str(&delta);
                        yield Ok(Event::Text(delta));
                    }
                    Ok(Chunk::Call(call)) => {
                        calls.push(call.clone());
                        yield Ok(Event::Call(call));
                    }
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            drop(chunks);

            if let Some(error) = failure {
                match (error.kind, &compact) {
                    (ErrorKind::ContextOverflow, Some(compact)) => {
                        let before = messages.len();
                        messages = compact(messages).await;
                        // A compaction that frees nothing would loop forever.
                        if messages.len() >= before {
                            yield Err(error);
                            return;
                        }
                        continue;
                    }
                    (ErrorKind::Fatal | ErrorKind::ContextOverflow, _) => {
                        yield Err(error);
                        return;
                    }
                    _ => {
                        let wait = error.retry_after.unwrap_or(DEFAULT_WAIT);
                        yield Ok(Event::Wait { ms: wait.as_millis() as u64, reason: error.message });
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                }
            }

            yield Ok(Event::Assistant { text: text.clone(), calls: calls.clone() });
            messages.push(Message::Assistant { text, calls: calls.clone() });
            if calls.is_empty() {
                break;
            }

            let results = join_all(calls.iter().map(|call| {
                let id = call.id.clone();
                let name = call.name.clone();
                let run = tools.get(&call.name).map(|tool| tool.run(call.input.clone(), cancel.clone()));
                async move {
                    let output = match run {
                        None => format!("error: unknown tool {name}"),
                        // A failing tool is information for the model, not a reason to stop.
                        Some(run) => run.await.unwrap_or_else(|error| format!("error: {error}")),
                    };
                    (id, output)
                }
            }))
            .await;
            for (id, output) in results {
                yield Ok(Event::Result { id: id.clone(), output: output.clone() });
                messages.push(Message::Tool { id, output });
            }
        }

        yield Ok(Event::Done(messages));
    })
}
