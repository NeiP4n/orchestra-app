use async_stream::stream;
use futures::StreamExt;
use futures::stream::BoxStream;
use orchestra_kernel::{Chunk, ErrorKind, Message, Request, ToolCall, Transport, TransportError};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Any server speaking the OpenAI chat-completions protocol with streaming: hosted services with
/// the person's own key, a local runtime, or a gateway. Nothing here is specific to one vendor.
pub struct Compatible {
    pub base: String,
    pub key: Option<String>,
    pub model: String,
    pub client: reqwest::Client,
}

impl Compatible {
    pub fn new(base: &str, key: Option<String>, model: &str) -> Self {
        Self { base: base.trim_end_matches('/').into(), key, model: model.into(), client: reqwest::Client::new() }
    }

    fn body(&self, request: &Request) -> Value {
        let mut messages = Vec::new();
        if let Some(system) = &request.system {
            messages.push(json!({ "role": "system", "content": system }));
        }
        for message in &request.messages {
            messages.push(match message {
                Message::User { text } => json!({ "role": "user", "content": text }),
                Message::Assistant { text, calls } if calls.is_empty() => json!({ "role": "assistant", "content": text }),
                Message::Assistant { text, calls } => json!({
                    "role": "assistant",
                    "content": text,
                    "tool_calls": calls.iter().map(|call| json!({
                        "id": call.id,
                        "type": "function",
                        "function": { "name": call.name, "arguments": call.input },
                    })).collect::<Vec<_>>(),
                }),
                Message::Tool { id, output } => json!({ "role": "tool", "tool_call_id": id, "content": output }),
            });
        }
        let mut body = json!({ "model": self.model, "stream": true, "messages": messages });
        if !request.tools.is_empty() {
            body["tools"] = request
                .tools
                .iter()
                .map(|tool| {
                    let parameters = serde_json::from_str(&tool.schema).unwrap_or(json!({ "type": "object" }));
                    json!({ "type": "function", "function": { "name": tool.name, "description": tool.description, "parameters": parameters } })
                })
                .collect();
        }
        body
    }
}

impl Transport for Compatible {
    fn id(&self) -> String {
        format!("{}#{}", self.base, self.model)
    }

    fn send(&self, request: Request, cancel: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
        let builder = {
            let builder = self.client.post(format!("{}/chat/completions", self.base)).json(&self.body(&request));
            match &self.key {
                Some(key) => builder.bearer_auth(key),
                None => builder,
            }
        };
        Box::pin(stream! {
            let response = tokio::select! {
                _ = cancel.cancelled() => return,
                response = builder.send() => response,
            };
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    yield Err(TransportError::new(error.to_string(), ErrorKind::Unavailable).retry_after(Duration::from_secs(5)));
                    return;
                }
            };
            if !response.status().is_success() {
                let status = response.status();
                let retry = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(Duration::from_secs);
                let body = response.text().await.unwrap_or_default();
                yield Err(classify(status.as_u16(), &body, retry));
                return;
            }

            let mut bytes = response.bytes_stream();
            let mut pending = String::new();
            let mut calls: BTreeMap<u64, (String, String, String)> = BTreeMap::new();
            'read: loop {
                let next = tokio::select! {
                    _ = cancel.cancelled() => return,
                    next = bytes.next() => next,
                };
                let Some(next) = next else { break };
                let chunk = match next {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        yield Err(TransportError::new(error.to_string(), ErrorKind::Unavailable));
                        return;
                    }
                };
                pending.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(end) = pending.find('\n') {
                    let line: String = pending.drain(..=end).collect();
                    let Some(data) = line.trim().strip_prefix("data:") else { continue };
                    let data = data.trim();
                    if data == "[DONE]" {
                        break 'read;
                    }
                    let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
                    let delta = &event["choices"][0]["delta"];
                    if let Some(text) = delta["content"].as_str().filter(|text| !text.is_empty()) {
                        yield Ok(Chunk::Text(text.to_string()));
                    }
                    for part in delta["tool_calls"].as_array().into_iter().flatten() {
                        let entry = calls.entry(part["index"].as_u64().unwrap_or(0)).or_default();
                        if let Some(id) = part["id"].as_str() {
                            entry.0 = id.to_string();
                        }
                        if let Some(name) = part["function"]["name"].as_str() {
                            entry.1.push_str(name);
                        }
                        if let Some(arguments) = part["function"]["arguments"].as_str() {
                            entry.2.push_str(arguments);
                        }
                    }
                }
            }
            for (index, (id, name, input)) in calls {
                let id = if id.is_empty() { format!("call_{index}") } else { id };
                let input = if input.is_empty() { "{}".to_string() } else { input };
                yield Ok(Chunk::Call(ToolCall { id, name, input }));
            }
        })
    }
}

fn classify(status: u16, body: &str, retry: Option<Duration>) -> TransportError {
    let message = format!("HTTP {status}: {}", body.chars().take(300).collect::<String>());
    let lowered = body.to_lowercase();
    if lowered.contains("context_length") || lowered.contains("maximum context") || lowered.contains("too many tokens") {
        return TransportError::new(message, ErrorKind::ContextOverflow);
    }
    match status {
        429 => TransportError::new(message, ErrorKind::RateLimit).retry_after(retry.unwrap_or(Duration::from_secs(20))),
        // Out of funds: this source is unusable until topped up, but a pool should move on, not stop.
        402 => TransportError::new(message, ErrorKind::Unavailable).retry_after(Duration::from_secs(600)),
        500..=599 | 408 => TransportError::new(message, ErrorKind::Unavailable).retry_after(retry.unwrap_or(Duration::from_secs(5))),
        _ => TransportError::new(message, ErrorKind::Fatal),
    }
}

/// A person answers. Lets the whole stack run with no key, no network and no model: type text for
/// a reply, or `/call <tool> <json>` to make the "model" call a tool.
pub struct Human;

impl Transport for Human {
    fn id(&self) -> String {
        "human".into()
    }

    fn send(&self, request: Request, _: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
        Box::pin(stream! {
            if let Some(last) = request.messages.last() {
                let shown = match last {
                    Message::User { text } => format!("user: {text}"),
                    Message::Tool { output, .. } => format!("tool result: {output}"),
                    Message::Assistant { text, .. } => format!("assistant: {text}"),
                };
                eprintln!("┆ {shown}");
            }
            eprint!("┆ answer (or /call <tool> <json>) > ");
            let line = tokio::task::spawn_blocking(|| {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).map(|_| line)
            })
            .await;
            let line = match line {
                Ok(Ok(line)) if !line.is_empty() => line,
                _ => {
                    yield Err(TransportError::new("input closed", ErrorKind::Fatal));
                    return;
                }
            };
            let line = line.trim();
            match line.strip_prefix("/call ") {
                Some(rest) => {
                    let (name, input) = rest.split_once(' ').unwrap_or((rest, "{}"));
                    yield Ok(Chunk::Call(ToolCall { id: format!("human_{}", request.messages.len()), name: name.into(), input: input.into() }));
                }
                None => yield Ok(Chunk::Text(line.to_string())),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 65536];
            let _ = socket.read(&mut buffer).await;
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{address}")
    }

    fn request() -> Request {
        Request { messages: vec![Message::User { text: "hi".into() }], ..Request::default() }
    }

    #[tokio::test]
    async fn streams_text_and_assembles_tool_calls_from_fragments() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"comm\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"and\\\":\\\"ls\\\"}\"}}]}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let response: &'static str = Box::leak(
            format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).into_boxed_str(),
        );
        let transport = Compatible::new(&serve(response).await, None, "m");
        let chunks: Vec<_> = transport.send(request(), CancellationToken::new()).collect().await;
        let chunks: Vec<Chunk> = chunks.into_iter().map(|chunk| chunk.unwrap()).collect();
        assert_eq!(
            chunks,
            [
                Chunk::Text("Hel".into()),
                Chunk::Text("lo".into()),
                Chunk::Call(ToolCall { id: "c1".into(), name: "shell".into(), input: "{\"command\":\"ls\"}".into() }),
            ]
        );
    }

    #[tokio::test]
    async fn maps_http_failures_to_the_error_kinds_the_pool_understands() {
        let limited = serve("HTTP/1.1 429 Too Many Requests\r\nretry-after: 7\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        let first: Vec<_> = Compatible::new(&limited, None, "m").send(request(), CancellationToken::new()).collect().await;
        let error = first[0].as_ref().unwrap_err();
        assert_eq!(error.kind, ErrorKind::RateLimit);
        assert_eq!(error.retry_after, Some(Duration::from_secs(7)));

        let denied = serve("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        let second: Vec<_> = Compatible::new(&denied, None, "m").send(request(), CancellationToken::new()).collect().await;
        assert_eq!(second[0].as_ref().unwrap_err().kind, ErrorKind::Fatal);
    }

    #[test]
    fn out_of_funds_lets_a_pool_move_on() {
        assert_eq!(classify(402, "Insufficient account funds", None).kind, ErrorKind::Unavailable);
    }

    #[test]
    fn context_overflow_is_recognised_from_the_body() {
        let error = classify(400, "{\"error\":{\"code\":\"context_length_exceeded\"}}", None);
        assert_eq!(error.kind, ErrorKind::ContextOverflow);
    }
}
