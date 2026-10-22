use futures::StreamExt;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use orchestra_kernel::{Chunk, Message, Request, Tool, ToolCall, Transport, TransportError};
use orchestra_session::{Entry, Session, Store, StoreError, Turn, drive};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_util::sync::CancellationToken;

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("orchestra-session-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

struct Script {
    turns: Vec<Vec<Chunk>>,
    index: AtomicUsize,
}

impl Transport for Script {
    fn id(&self) -> String {
        "script".into()
    }
    fn send(&self, _: Request, _: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
        let at = self.index.fetch_add(1, Ordering::SeqCst).min(self.turns.len() - 1);
        futures::stream::iter(self.turns[at].clone().into_iter().map(Ok)).boxed()
    }
}

struct Echo;
impl Tool for Echo {
    fn name(&self) -> &str {
        "echo"
    }
    fn run(&self, input: String, _: CancellationToken) -> BoxFuture<'static, Result<String, String>> {
        Box::pin(async move { Ok(format!("echo:{input}")) })
    }
}

fn call(id: &str) -> ToolCall {
    ToolCall { id: id.into(), name: "echo".into(), input: id.into() }
}

#[tokio::test]
async fn a_session_survives_reopening() {
    let store = Store::open(temp("reopen")).await.unwrap();
    Session::create(&store, "s1", "first").await.unwrap();
    store.append("s1", &Entry::Message { message: Message::User { text: "hi".into() } }).await.unwrap();
    let reopened = Session::open(&store, "s1").await.unwrap();
    assert_eq!(reopened.title, "first");
    assert_eq!(reopened.messages, [Message::User { text: "hi".into() }]);
    assert_eq!(store.list().await.unwrap(), ["s1"]);
}

#[tokio::test]
async fn missing_sessions_are_reported() {
    let store = Store::open(temp("missing")).await.unwrap();
    assert!(matches!(Session::open(&store, "nope").await, Err(StoreError::Missing(_))));
}

#[tokio::test]
async fn drive_persists_every_step_as_it_happens() {
    let store = Store::open(temp("drive")).await.unwrap();
    let session = Session::create(&store, "s", "t").await.unwrap();
    let transport = Arc::new(Script {
        turns: vec![vec![Chunk::Text("calling".into()), Chunk::Call(call("a"))], vec![Chunk::Text("done".into())]],
        index: AtomicUsize::new(0),
    });
    let turn = Turn {
        store: store.clone(),
        session,
        transport,
        tools: vec![Arc::new(Echo)],
        system: None,
        cancel: CancellationToken::new(),
    };
    let events: Vec<_> = drive(turn, "go".into()).collect().await;
    assert!(events.iter().all(|event| event.is_ok()));

    let saved = Session::open(&store, "s").await.unwrap();
    assert_eq!(
        saved.messages,
        [
            Message::User { text: "go".into() },
            Message::Assistant { text: "calling".into(), calls: vec![call("a")] },
            Message::Tool { id: "a".into(), output: "echo:a".into() },
            Message::Assistant { text: "done".into(), calls: vec![] },
        ]
    );
}

#[tokio::test]
async fn calls_without_results_are_repaired_once_after_a_crash() {
    let store = Store::open(temp("crash")).await.unwrap();
    Session::create(&store, "s", "t").await.unwrap();
    store
        .append("s", &Entry::Message { message: Message::Assistant { text: "x".into(), calls: vec![call("lost")] } })
        .await
        .unwrap();

    let first = Session::open(&store, "s").await.unwrap();
    assert_eq!(
        first.messages.last(),
        Some(&Message::Tool { id: "lost".into(), output: "error: interrupted before completion".into() })
    );
    let second = Session::open(&store, "s").await.unwrap();
    assert_eq!(second.messages.len(), first.messages.len());
}

#[tokio::test]
async fn a_torn_last_line_is_ignored_but_earlier_damage_is_an_error() {
    let dir = temp("torn");
    let store = Store::open(&dir).await.unwrap();
    Session::create(&store, "s", "t").await.unwrap();
    let path = dir.join("s.jsonl");

    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("{\"type\":\"mess");
    std::fs::write(&path, &text).unwrap();
    assert_eq!(Session::open(&store, "s").await.unwrap().title, "t");

    std::fs::write(&path, format!("garbage\n{text}")).unwrap();
    assert!(matches!(Session::open(&store, "s").await, Err(StoreError::Corrupt { line: 1, .. })));
}
