//! The clipboard transport: a person's own chat subscription becomes the model, with no API, no
//! key and no automation of anyone's website. Orchestra puts the whole request on the clipboard,
//! the person pastes it into any chat they already use and copies the reply, and Orchestra picks
//! the reply up the moment the clipboard changes. A human stays in the loop, so it is lawful by
//! construction; it costs one paste and one copy per step.
use async_stream::stream;
use futures::stream::BoxStream;
use orchestra_kernel::{Chunk, ErrorKind, Message, Request, ToolCall, Transport, TransportError};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub trait Board: Send + Sync {
    fn get(&self) -> Option<String>;
    fn set(&self, text: &str) -> bool;
}

/// The operating system clipboard, reached through the tools every desktop ships with.
pub struct System;

impl Board for System {
    fn get(&self) -> Option<String> {
        let output = if cfg!(windows) {
            Command::new("powershell")
                .args(["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])
                .output()
        } else if cfg!(target_os = "macos") {
            Command::new("pbpaste").output()
        } else {
            Command::new("sh").args(["-c", "wl-paste 2>/dev/null || xclip -selection clipboard -o"]).output()
        }
        .ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).to_string())
    }

    fn set(&self, text: &str) -> bool {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell");
            command.args(["-NoProfile", "-Command", "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"]);
            command
        } else if cfg!(target_os = "macos") {
            Command::new("pbcopy")
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "wl-copy 2>/dev/null || xclip -selection clipboard"]);
            command
        };
        let Ok(mut child) = command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
            return false;
        };
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(text.as_bytes());
        }
        child.wait().is_ok_and(|status| status.success())
    }
}

pub struct Clipboard {
    board: Arc<dyn Board>,
    poll: Duration,
    open: Option<String>,
}

impl Clipboard {
    pub fn new(board: Arc<dyn Board>, poll: Duration) -> Self {
        Self { board, poll, open: None }
    }

    /// Opens this page in the default browser whenever a request is ready to paste.
    pub fn opening(mut self, url: Option<String>) -> Self {
        self.open = url;
        self
    }
}

impl Transport for Clipboard {
    fn id(&self) -> String {
        "clipboard".into()
    }

    fn send(&self, request: Request, cancel: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
        let board = self.board.clone();
        let poll = self.poll;
        let open = self.open.clone();
        Box::pin(stream! {
            let prompt = render(&request);
            if !board.set(&prompt) {
                yield Err(TransportError::new("cannot write to the clipboard", ErrorKind::Fatal));
                return;
            }
            eprintln!("┆ request copied. Paste it into your chat, then copy the reply; it is picked up automatically.");
            if let Some(url) = &open {
                browse(url);
            }
            let answer = loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(poll) => {}
                }
                let Some(text) = board.get() else { continue };
                if !text.trim().is_empty() && text.trim() != prompt.trim() {
                    break text;
                }
            };
            eprint!("┆ reply received
");
            for chunk in parse(&answer) {
                yield Ok(chunk);
            }
        })
    }
}

fn browse(url: &str) {
    // Only web pages: the setting is a convenience, not a way to start arbitrary programs.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    let _ = if cfg!(windows) {
        Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
}

pub fn render(request: &Request) -> String {
    let mut out = String::from(
        "You are the model inside a tool-using agent called Orchestra. Read the conversation and write the next assistant reply.\n\
         To use a tool, write a line that starts with `@call`, then the tool name, then the JSON input on the same line, e.g.\n\
         @call shell {\"command\":\"dir\"}\n\
         Anything else you write is shown to the user. When the work is finished, answer in plain text with no @call line.\n",
    );
    if !request.tools.is_empty() {
        out.push_str("\nTools:\n");
        for tool in &request.tools {
            out.push_str(&format!("- {}: {} (input schema: {})\n", tool.name, tool.description, tool.schema));
        }
    }
    if let Some(system) = &request.system {
        out.push_str(&format!("\nInstructions:\n{system}\n"));
    }
    out.push_str("\n=== conversation ===\n");
    for message in &request.messages {
        match message {
            Message::User { text } => out.push_str(&format!("[user]\n{text}\n")),
            Message::Assistant { text, calls } => {
                out.push_str("[assistant]\n");
                if !text.is_empty() {
                    out.push_str(&format!("{text}\n"));
                }
                for call in calls {
                    out.push_str(&format!("@call {} {}\n", call.name, call.input));
                }
            }
            Message::Tool { output, .. } => out.push_str(&format!("[tool result]\n{output}\n")),
        }
    }
    out.push_str("=== end ===\nWrite only the next assistant reply.\n");
    out
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

pub fn parse(answer: &str) -> Vec<Chunk> {
    let mut text = Vec::new();
    let mut calls = Vec::new();
    for line in answer.lines() {
        let trimmed = line.trim().trim_start_matches('>').trim_start();
        if trimmed.starts_with("```") {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("@call ") else {
            text.push(line);
            continue;
        };
        let (name, input) = rest.trim().split_once(char::is_whitespace).unwrap_or((rest.trim(), "{}"));
        let id = format!("clip_{}", NEXT.fetch_add(1, Ordering::SeqCst));
        calls.push(Chunk::Call(ToolCall { id, name: name.to_string(), input: input.trim().to_string() }));
    }
    let text = text.join("\n").trim().to_string();
    let mut chunks = Vec::new();
    if !text.is_empty() {
        chunks.push(Chunk::Text(text));
    }
    chunks.extend(calls);
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use orchestra_kernel::ToolSpec;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Memory(Mutex<Option<String>>);

    impl Board for Memory {
        fn get(&self) -> Option<String> {
            self.0.lock().unwrap().clone()
        }
        fn set(&self, text: &str) -> bool {
            *self.0.lock().unwrap() = Some(text.into());
            true
        }
    }

    #[test]
    fn parses_text_and_call_lines_even_inside_fences_and_quotes() {
        let chunks = parse("I will look.\n```\n@call list_dir {\"path\":\".\"}\n```\n> @call shell {\"command\":\"dir\"}\n");
        assert_eq!(chunks[0], Chunk::Text("I will look.".into()));
        let calls: Vec<_> = chunks[1..]
            .iter()
            .map(|chunk| match chunk {
                Chunk::Call(call) => (call.name.clone(), call.input.clone()),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(calls, [("list_dir".into(), "{\"path\":\".\"}".into()), ("shell".into(), "{\"command\":\"dir\"}".into())]);
    }

    #[test]
    fn a_plain_reply_is_just_text_and_ids_are_unique() {
        assert_eq!(parse("  done  "), [Chunk::Text("done".into())]);
        let ids = |chunks: Vec<Chunk>| match &chunks[0] {
            Chunk::Call(call) => call.id.clone(),
            other => panic!("unexpected {other:?}"),
        };
        assert_ne!(ids(parse("@call a {}")), ids(parse("@call a {}")));
    }

    #[test]
    fn the_rendered_request_carries_tools_history_and_the_reply_protocol() {
        let request = Request {
            messages: vec![
                Message::User { text: "list files".into() },
                Message::Assistant { text: "ok".into(), calls: vec![ToolCall { id: "1".into(), name: "list_dir".into(), input: "{}".into() }] },
                Message::Tool { id: "1".into(), output: "a.txt".into() },
            ],
            system: Some("be brief".into()),
            tools: vec![ToolSpec { name: "list_dir".into(), description: "List".into(), schema: "{}".into() }],
        };
        let text = render(&request);
        for needle in ["@call", "- list_dir: List", "be brief", "[user]\nlist files", "@call list_dir {}", "[tool result]\na.txt"] {
            assert!(text.contains(needle), "missing {needle}");
        }
    }

    #[tokio::test]
    async fn waits_for_the_clipboard_to_change_then_returns_the_pasted_reply() {
        let board = Arc::new(Memory::default());
        let transport = Clipboard::new(board.clone(), Duration::from_millis(5));
        let replier = board.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            replier.set("hello from my chat\n@call shell {\"command\":\"dir\"}");
        });
        let request = Request { messages: vec![Message::User { text: "hi".into() }], ..Request::default() };
        let chunks: Vec<_> = transport.send(request, CancellationToken::new()).collect().await;
        let chunks: Vec<Chunk> = chunks.into_iter().map(|chunk| chunk.unwrap()).collect();
        assert_eq!(chunks[0], Chunk::Text("hello from my chat".into()));
        assert!(matches!(&chunks[1], Chunk::Call(call) if call.name == "shell"));
    }

    // Needs a desktop session, so it only runs on request: cargo test -- --ignored
    #[test]
    #[ignore]
    fn the_system_clipboard_round_trips_unicode() {
        let text = "привет ░▒▓ @call x {}";
        assert!(System.set(text));
        assert_eq!(System.get().unwrap().trim_end(), text);
    }

    #[tokio::test]
    async fn cancelling_stops_the_wait() {
        let board = Arc::new(Memory::default());
        let transport = Clipboard::new(board, Duration::from_millis(5));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let chunks: Vec<_> = transport.send(Request::default(), cancel).collect().await;
        assert!(chunks.is_empty());
    }
}
