//! The CLI bridge: an official agent program the person already has and is signed in to (their own
//! Claude, Codex, OpenCode ...) becomes the model. Orchestra starts it in its documented
//! non-interactive mode, feeds the request on stdin and reads the reply from stdout. Nothing about
//! the service is imitated: the genuine client talks to the service with the person's own login.
use crate::clipboard::{parse, render};
use async_stream::stream;
use futures::stream::BoxStream;
use orchestra_kernel::{Chunk, ErrorKind, Request, Transport, TransportError};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub struct Cli {
    pub command: Vec<String>,
}

/// Official programs and how to run them headless with the prompt on stdin.
pub const PRESETS: [(&str, &[&str]); 4] = [
    ("claude-cli", &["claude", "-p"]),
    ("codex-cli", &["codex", "exec", "-"]),
    ("opencode-cli", &["opencode", "run", "--standalone"]),
    ("gemini-cli", &["gemini", "-p", "Follow the instructions given on stdin.", "--skip-trust"]),
];

pub fn preset(name: &str) -> Option<Vec<String>> {
    PRESETS
        .iter()
        .find(|(preset, _)| *preset == name.trim().to_lowercase())
        .map(|(_, command)| command.iter().map(|part| part.to_string()).collect())
}

impl Transport for Cli {
    fn id(&self) -> String {
        format!("cli:{}", self.command.first().map_or("?", |name| name.as_str()))
    }

    fn send(&self, request: Request, cancel: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
        let command = self.command.clone();
        Box::pin(stream! {
            let prompt = render(&request);
            let Some((program, args)) = command.split_first() else {
                yield Err(TransportError::new("empty command", ErrorKind::Fatal));
                return;
            };
            if !installed(program) {
                yield Err(TransportError::new(missing(program), ErrorKind::Fatal));
                return;
            }
            // npm-installed tools are .cmd shims on Windows, which only the shell can start.
            let mut process = if cfg!(windows) {
                let mut process = tokio::process::Command::new("cmd");
                process.arg("/C").arg(program).args(args);
                process
            } else {
                let mut process = tokio::process::Command::new(program);
                process.args(args);
                process
            };
            process.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
            let mut child = match process.spawn() {
                Ok(child) => child,
                Err(error) => {
                    yield Err(TransportError::new(format!("cannot start `{program}`: {error}"), ErrorKind::Fatal));
                    return;
                }
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(prompt.as_bytes()).await;
            }
            let output = tokio::select! {
                _ = cancel.cancelled() => return,
                output = child.wait_with_output() => output,
            };
            let output = match output {
                Ok(output) => output,
                Err(error) => {
                    yield Err(TransportError::new(error.to_string(), ErrorKind::Unavailable));
                    return;
                }
            };
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let last = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("no output").trim().to_string();
                yield Err(classify(&format!("{program} failed: {last}"), &format!("{stdout}{stderr}")));
                return;
            }
            if stdout.trim().is_empty() {
                yield Err(TransportError::new(format!("{program} returned nothing"), ErrorKind::Unavailable));
                return;
            }
            for chunk in parse(&stdout) {
                yield Ok(chunk);
            }
        })
    }
}

/// Whether the shell can find `program`. Checked up front because the shell reports a missing
/// program in the console code page, which would reach the user as unreadable text.
fn installed(program: &str) -> bool {
    let finder = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(finder)
        .arg(program)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn missing(program: &str) -> String {
    let how = match program {
        "claude" => " Установка: npm install -g @anthropic-ai/claude-code, затем один раз запустите `claude` и войдите.",
        "codex" => " Установка: npm install -g @openai/codex, затем один раз запустите `codex` и войдите.",
        "opencode" => " Установка: https://opencode.ai",
        _ => "",
    };
    format!("программа `{program}` не найдена на этом компьютере.{how} Или выберите другой источник: orchestra setup")
}

fn classify(detail: &str, everything: &str) -> TransportError {
    let lowered = everything.to_lowercase();
    let limited = ["rate limit", "quota", "usage limit", "too many requests", "429", "free usage limit"];
    if limited.iter().any(|word| lowered.contains(word)) {
        return TransportError::new(detail, ErrorKind::RateLimit).retry_after(Duration::from_secs(120));
    }
    TransportError::new(detail, ErrorKind::Unavailable).retry_after(Duration::from_secs(30))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use orchestra_kernel::Message;

    fn request() -> Request {
        Request { messages: vec![Message::User { text: "hello bridge".into() }], ..Request::default() }
    }

    async fn run(command: &[&str]) -> Vec<Result<Chunk, TransportError>> {
        let cli = Cli { command: command.iter().map(|part| part.to_string()).collect() };
        cli.send(request(), CancellationToken::new()).collect().await
    }

    #[tokio::test]
    async fn feeds_the_request_on_stdin_and_parses_stdout() {
        // `more` / `cat` echo stdin, so the reply contains the whole request.
        let echo: &[&str] = if cfg!(windows) { &["more"] } else { &["cat"] };
        let chunks = run(echo).await;
        let text: String = chunks
            .iter()
            .filter_map(|chunk| match chunk {
                Ok(Chunk::Text(text)) => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert!(text.contains("hello bridge"), "got {text}");
    }

    #[tokio::test]
    async fn a_missing_program_cannot_start_and_a_failing_one_is_skippable() {
        let missing = run(&["definitely-not-installed-orchestra"]).await;
        let error = missing[0].as_ref().unwrap_err();
        assert_eq!(error.kind, ErrorKind::Fatal);
        assert!(error.message.contains("не найдена"));

        let failing: &[&str] = if cfg!(windows) { &["cmd", "/C", "exit 3"] } else { &["sh", "-c", "exit 3"] };
        assert_eq!(run(failing).await[0].as_ref().unwrap_err().kind, ErrorKind::Unavailable);
    }

    #[test]
    fn limit_messages_become_rate_limits_and_presets_resolve() {
        assert_eq!(classify("x", "Free usage limit reached").kind, ErrorKind::RateLimit);
        assert_eq!(classify("x", "boom").kind, ErrorKind::Unavailable);
        assert_eq!(preset("Claude-CLI").unwrap()[0], "claude");
        assert!(preset("nope").is_none());
    }
}
