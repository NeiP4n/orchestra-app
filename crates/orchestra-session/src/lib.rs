//! Sessions are an append-only log of entries. The log is the only source of truth: the visible
//! history is a fold over it, and a crash can lose at most the entry being written.
use async_stream::stream;
use futures::StreamExt;
use futures::stream::BoxStream;
use orchestra_kernel::{Event, Message, Options, Tool, Transport, TransportError, run};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Entry {
    Started { title: String },
    Message { message: Message },
}

#[derive(Clone, Debug)]
pub struct Store {
    dir: PathBuf,
}

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Corrupt { line: usize, reason: String },
    Missing(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(error) => write!(f, "{error}"),
            StoreError::Corrupt { line, reason } => write!(f, "corrupt entry on line {line}: {reason}"),
            StoreError::Missing(id) => write!(f, "no session {id}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        StoreError::Io(error)
    }
}

impl Store {
    pub async fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        tokio::fs::create_dir_all(&dir).await?;
        Ok(Self { dir })
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.jsonl"))
    }

    pub async fn append(&self, id: &str, entry: &Entry) -> Result<(), StoreError> {
        let mut line = serde_json::to_string(entry).expect("entries always serialize");
        line.push('\n');
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(self.path(id)).await?;
        file.write_all(line.as_bytes()).await?;
        file.flush().await?;
        Ok(())
    }

    pub async fn load(&self, id: &str) -> Result<Vec<Entry>, StoreError> {
        let text = tokio::fs::read_to_string(self.path(id))
            .await
            .map_err(|error| if error.kind() == std::io::ErrorKind::NotFound { StoreError::Missing(id.into()) } else { error.into() })?;
        let lines: Vec<&str> = text.lines().collect();
        let mut entries = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            match serde_json::from_str(line) {
                Ok(entry) => entries.push(entry),
                // A torn final line is what a crash mid-write leaves behind; anything earlier is real damage.
                Err(_) if index + 1 == lines.len() => {}
                Err(error) => return Err(StoreError::Corrupt { line: index + 1, reason: error.to_string() }),
            }
        }
        Ok(entries)
    }

    pub async fn list(&self) -> Result<Vec<String>, StoreError> {
        let mut found = Vec::new();
        let mut dir = tokio::fs::read_dir(&self.dir).await?;
        while let Some(item) = dir.next_entry().await? {
            let name = item.file_name().to_string_lossy().to_string();
            if let Some(id) = name.strip_suffix(".jsonl") {
                found.push(id.to_string());
            }
        }
        found.sort();
        Ok(found)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub messages: Vec<Message>,
}

impl Session {
    pub async fn create(store: &Store, id: &str, title: &str) -> Result<Self, StoreError> {
        store.append(id, &Entry::Started { title: title.into() }).await?;
        Ok(Self { id: id.into(), title: title.into(), messages: Vec::new() })
    }

    /// Folds the log into a session. Calls that never received a result (the process died while
    /// tools ran) are answered with an interruption notice, and the notice is persisted so the
    /// repair happens once.
    pub async fn open(store: &Store, id: &str) -> Result<Self, StoreError> {
        let mut session = fold(id, store.load(id).await?);
        for message in repair(&session.messages) {
            store.append(id, &Entry::Message { message: message.clone() }).await?;
            session.messages.push(message);
        }
        Ok(session)
    }
}

fn fold(id: &str, entries: Vec<Entry>) -> Session {
    let mut session = Session { id: id.into(), title: String::new(), messages: Vec::new() };
    for entry in entries {
        match entry {
            Entry::Started { title } => session.title = title,
            Entry::Message { message } => session.messages.push(message),
        }
    }
    session
}

fn repair(messages: &[Message]) -> Vec<Message> {
    let answered: std::collections::HashSet<&str> = messages
        .iter()
        .filter_map(|message| match message {
            Message::Tool { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    messages
        .iter()
        .flat_map(|message| match message {
            Message::Assistant { calls, .. } => calls.iter().collect::<Vec<_>>(),
            _ => Vec::new(),
        })
        .filter(|call| !answered.contains(call.id.as_str()))
        .map(|call| Message::Tool { id: call.id.clone(), output: "error: interrupted before completion".into() })
        .collect()
}

pub struct Turn {
    pub store: Store,
    pub session: Session,
    pub transport: Arc<dyn Transport>,
    pub tools: Vec<Arc<dyn Tool>>,
    pub system: Option<String>,
    pub cancel: CancellationToken,
}

/// Runs one user prompt to completion, persisting each entry the moment it exists.
pub fn drive(turn: Turn, prompt: String) -> BoxStream<'static, Result<Event, TransportError>> {
    Box::pin(stream! {
        let Turn { store, mut session, transport, tools, system, cancel } = turn;
        let user = Message::User { text: prompt };
        if let Err(error) = store.append(&session.id, &Entry::Message { message: user.clone() }).await {
            yield Err(TransportError::new(error.to_string(), orchestra_kernel::ErrorKind::Fatal));
            return;
        }
        session.messages.push(user);

        let mut events = run(Options {
            transport,
            tools,
            messages: session.messages.clone(),
            system,
            cancel,
            compact: Some(Arc::new(|messages| Box::pin(async move { trim(&messages) }))),
        });
        while let Some(event) = events.next().await {
            let message = match &event {
                Ok(Event::Assistant { text, calls }) => Some(Message::Assistant { text: text.clone(), calls: calls.clone() }),
                Ok(Event::Result { id, output }) => Some(Message::Tool { id: id.clone(), output: output.clone() }),
                _ => None,
            };
            if let Some(message) = message
                && let Err(error) = store.append(&session.id, &Entry::Message { message }).await
            {
                yield Err(TransportError::new(error.to_string(), orchestra_kernel::ErrorKind::Fatal));
                return;
            }
            yield event;
        }
    })
}

/// Default compaction: keep the working copy from the most recent user prompt on. The log keeps
/// everything; only what is sent to the model shrinks. Cuts only at a user message, so a tool call
/// is never separated from its result. Returns the input unchanged when nothing can be dropped.
pub fn trim(messages: &[Message]) -> Vec<Message> {
    let start = messages.iter().rposition(|message| matches!(message, Message::User { .. })).unwrap_or(0);
    messages[start..].to_vec()
}
