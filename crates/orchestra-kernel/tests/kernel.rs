use futures::StreamExt;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use orchestra_kernel::{
    Chunk, ErrorKind, Event, Message, Options, Pool, Request, Tool, ToolCall, Transport,
    TransportError, run,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

type Turn = Result<Vec<Chunk>, TransportError>;

struct Scripted {
    id: &'static str,
    turns: Vec<Turn>,
    index: AtomicUsize,
}

impl Transport for Scripted {
    fn id(&self) -> String {
        self.id.to_string()
    }

    fn send(&self, _: Request, _: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
        let at = self.index.fetch_add(1, Ordering::SeqCst).min(self.turns.len() - 1);
        match self.turns[at].clone() {
            Ok(chunks) => futures::stream::iter(chunks.into_iter().map(Ok)).boxed(),
            Err(error) => futures::stream::iter([Err(error)]).boxed(),
        }
    }
}

fn scripted(id: &'static str, turns: Vec<Turn>) -> Arc<Scripted> {
    Arc::new(Scripted { id, turns, index: AtomicUsize::new(0) })
}

fn text(delta: &str) -> Chunk {
    Chunk::Text(delta.to_string())
}

fn call(id: &str, name: &str) -> Chunk {
    Chunk::Call(ToolCall { id: id.into(), name: name.into(), input: id.into() })
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

struct Broken;
impl Tool for Broken {
    fn name(&self) -> &str {
        "broken"
    }
    fn run(&self, _: String, _: CancellationToken) -> BoxFuture<'static, Result<String, String>> {
        Box::pin(async { Err("boom".to_string()) })
    }
}

struct Slow {
    running: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}
impl Tool for Slow {
    fn name(&self) -> &str {
        "slow"
    }
    fn run(&self, _: String, _: CancellationToken) -> BoxFuture<'static, Result<String, String>> {
        let running = self.running.clone();
        let peak = self.peak.clone();
        Box::pin(async move {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            running.fetch_sub(1, Ordering::SeqCst);
            Ok("ok".to_string())
        })
    }
}

fn options(transport: Arc<dyn Transport>, tools: Vec<Arc<dyn Tool>>) -> Options {
    Options {
        transport,
        tools,
        messages: vec![Message::User { text: "go".into() }],
        system: None,
        cancel: CancellationToken::new(),
        compact: None,
    }
}

async fn collect(options: Options) -> Vec<Result<Event, TransportError>> {
    run(options).collect().await
}

fn events(items: Vec<Result<Event, TransportError>>) -> Vec<Event> {
    items.into_iter().map(|item| item.expect("stream failed")).collect()
}

#[tokio::test]
async fn runs_far_past_any_step_ceiling_and_stops_when_the_model_stops_calling_tools() {
    let mut turns: Vec<Turn> = (0..500).map(|index| Ok(vec![call(&format!("c{index}"), "echo")])).collect();
    turns.push(Ok(vec![text("finished")]));
    let all = events(collect(options(scripted("t", turns), vec![Arc::new(Echo)])).await);
    assert_eq!(all.iter().filter(|event| matches!(event, Event::Result { .. })).count(), 500);
    assert!(matches!(all.last(), Some(Event::Done(_))));
}

#[tokio::test(start_paused = true)]
async fn runs_the_calls_of_one_answer_in_parallel() {
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let slow = Slow { running: running.clone(), peak: peak.clone() };
    let turns = vec![Ok(vec![call("a", "slow"), call("b", "slow"), call("c", "slow")]), Ok(vec![text("done")])];
    collect(options(scripted("t", turns), vec![Arc::new(slow)])).await;
    assert_eq!(peak.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn feeds_tool_failures_back_to_the_model_instead_of_ending_the_session() {
    let turns = vec![Ok(vec![call("x", "broken")]), Ok(vec![call("y", "missing")]), Ok(vec![text("ok")])];
    let all = events(collect(options(scripted("t", turns), vec![Arc::new(Broken)])).await);
    let outputs: Vec<String> = all
        .into_iter()
        .filter_map(|event| match event {
            Event::Result { output, .. } => Some(output),
            _ => None,
        })
        .collect();
    assert_eq!(outputs, ["error: boom", "error: unknown tool missing"]);
}

#[tokio::test(start_paused = true)]
async fn waits_out_a_rate_limit_and_retries_the_same_transport() {
    let limited = TransportError::new("slow down", ErrorKind::RateLimit).retry_after(Duration::from_millis(250));
    let all = events(collect(options(scripted("t", vec![Err(limited), Ok(vec![text("hi")])]), vec![])).await);
    assert!(all.contains(&Event::Wait { ms: 250, reason: "slow down".into() }));
    assert!(all.contains(&Event::Text("hi".into())));
}

struct Overflowing {
    seen: Arc<Mutex<Vec<usize>>>,
}
impl Transport for Overflowing {
    fn id(&self) -> String {
        "t".into()
    }
    fn send(&self, request: Request, _: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
        self.seen.lock().unwrap().push(request.messages.len());
        if request.messages.len() > 1 {
            return futures::stream::iter([Err(TransportError::new("too long", ErrorKind::ContextOverflow))]).boxed();
        }
        futures::stream::iter([Ok(text("fits"))]).boxed()
    }
}

#[tokio::test]
async fn compacts_history_on_context_overflow_and_retries() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut setup = options(Arc::new(Overflowing { seen: seen.clone() }), vec![]);
    setup.messages = vec![Message::User { text: "a".into() }, Message::User { text: "b".into() }];
    setup.compact = Some(Arc::new(|messages| Box::pin(async move { messages[messages.len() - 1..].to_vec() })));
    collect(setup).await;
    assert_eq!(*seen.lock().unwrap(), [2, 1]);
}

#[tokio::test]
async fn a_fatal_failure_ends_the_session() {
    let turns = vec![Err(TransportError::new("bad key", ErrorKind::Fatal))];
    let all = collect(options(scripted("t", turns), vec![])).await;
    assert_eq!(all.last().unwrap().as_ref().unwrap_err().message, "bad key");
}

#[tokio::test]
async fn cancelling_stops_before_the_next_answer() {
    let setup = options(scripted("t", vec![Ok(vec![text("never")])]), vec![]);
    setup.cancel.cancel();
    let all = events(collect(setup).await);
    assert!(matches!(all.as_slice(), [Event::Done(_)]));
}

#[tokio::test]
async fn pool_fails_over_to_the_next_transport_when_one_is_rate_limited() {
    let first = scripted("first", vec![Err(TransportError::new("quota", ErrorKind::RateLimit).retry_after(Duration::from_secs(1)))]);
    let second = scripted("second", vec![Ok(vec![text("from second")])]);
    let pool = Pool::new(vec![first, second]);
    let all = events(collect(options(Arc::new(pool), vec![])).await);
    assert!(all.contains(&Event::Text("from second".into())));
}

struct Recording {
    id: &'static str,
    limited: bool,
    used: Arc<Mutex<Vec<String>>>,
}
impl Transport for Recording {
    fn id(&self) -> String {
        self.id.into()
    }
    fn send(&self, _: Request, _: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
        self.used.lock().unwrap().push(self.id.into());
        if self.limited {
            let error = TransportError::new("quota", ErrorKind::RateLimit).retry_after(Duration::from_millis(100));
            return futures::stream::iter([Err(error)]).boxed();
        }
        futures::stream::iter([Ok(text(self.id))]).boxed()
    }
}

#[tokio::test(start_paused = true)]
async fn pool_skips_a_resting_transport_until_its_time_passes() {
    let used = Arc::new(Mutex::new(Vec::new()));
    let pool = Pool::new(vec![
        Arc::new(Recording { id: "a", limited: true, used: used.clone() }),
        Arc::new(Recording { id: "b", limited: false, used: used.clone() }),
    ]);
    let drain = || async { pool.send(Request::default(), CancellationToken::new()).collect::<Vec<_>>().await };
    drain().await;
    drain().await;
    assert_eq!(*used.lock().unwrap(), ["a", "b", "b"]);
    tokio::time::advance(Duration::from_millis(200)).await;
    drain().await;
    assert_eq!(*used.lock().unwrap(), ["a", "b", "b", "a", "b"]);
}

#[tokio::test]
async fn pool_never_switches_transports_after_output_was_already_delivered() {
    let half = scripted("half", vec![Err(TransportError::new("dropped", ErrorKind::Unavailable))]);
    // A transport that yields text and then fails.
    struct Half;
    impl Transport for Half {
        fn id(&self) -> String {
            "half".into()
        }
        fn send(&self, _: Request, _: CancellationToken) -> BoxStream<'static, Result<Chunk, TransportError>> {
            futures::stream::iter([Ok(text("partial")), Err(TransportError::new("dropped", ErrorKind::Unavailable))]).boxed()
        }
    }
    drop(half);
    let never = scripted("never", vec![Ok(vec![text("duplicate")])]);
    let pool = Pool::new(vec![Arc::new(Half), never]);
    let items: Vec<_> = pool.send(Request::default(), CancellationToken::new()).collect().await;
    assert_eq!(items.len(), 2);
    assert_eq!(items[0], Ok(text("partial")));
    assert_eq!(items[1].as_ref().unwrap_err().message, "dropped");
}
