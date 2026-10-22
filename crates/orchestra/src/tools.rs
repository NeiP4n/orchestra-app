use futures::future::BoxFuture;
use orchestra_kernel::{Tool, ToolSpec};
use orchestra_memory::{Item, Memory, Scope};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

type Run = dyn Fn(Value, CancellationToken) -> BoxFuture<'static, Result<String, String>> + Send + Sync;

struct Handler {
    name: &'static str,
    description: &'static str,
    schema: Value,
    run: Box<Run>,
}

impl Tool for Handler {
    fn name(&self) -> &str {
        self.name
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec { name: self.name.into(), description: self.description.into(), schema: self.schema.to_string() }
    }

    fn run(&self, input: String, cancel: CancellationToken) -> BoxFuture<'static, Result<String, String>> {
        match serde_json::from_str::<Value>(&input) {
            Ok(value) => (self.run)(value, cancel),
            Err(error) => Box::pin(async move { Err(format!("input is not valid JSON: {error}")) }),
        }
    }
}

fn text(value: &Value, key: &str) -> Result<String, String> {
    value[key].as_str().map(String::from).ok_or_else(|| format!("missing string field `{key}`"))
}

pub fn all(memory: Arc<Memory>, project: String, session: String) -> Vec<Arc<dyn Tool>> {
    let tools: Vec<Handler> = vec![
        Handler {
            name: "shell",
            description: "Run a shell command in the working directory and return its combined output. No time limit; it stops when the session is cancelled.",
            schema: json!({ "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] }),
            run: Box::new(|input, cancel| {
                Box::pin(async move {
                    let command = text(&input, "command")?;
                    let mut process = if cfg!(windows) {
                        let mut process = tokio::process::Command::new("cmd");
                        process.args(["/C", &command]);
                        process
                    } else {
                        let mut process = tokio::process::Command::new("sh");
                        process.args(["-c", &command]);
                        process
                    };
                    process.kill_on_drop(true);
                    let output = tokio::select! {
                        _ = cancel.cancelled() => return Err("cancelled".to_string()),
                        output = process.output() => output.map_err(|error| error.to_string())?,
                    };
                    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
                    combined.push_str(&String::from_utf8_lossy(&output.stderr));
                    Ok(format!("exit {}\n{combined}", output.status.code().unwrap_or(-1)))
                })
            }),
        },
        Handler {
            name: "read_file",
            description: "Read a text file.",
            schema: json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }),
            run: Box::new(|input, _| {
                Box::pin(async move {
                    let path = text(&input, "path")?;
                    tokio::fs::read_to_string(&path).await.map_err(|error| format!("{path}: {error}"))
                })
            }),
        },
        Handler {
            name: "write_file",
            description: "Create or overwrite a text file, creating parent directories.",
            schema: json!({ "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] }),
            run: Box::new(|input, _| {
                Box::pin(async move {
                    let path = text(&input, "path")?;
                    let content = text(&input, "content")?;
                    if let Some(parent) = std::path::Path::new(&path).parent().filter(|parent| !parent.as_os_str().is_empty()) {
                        tokio::fs::create_dir_all(parent).await.map_err(|error| error.to_string())?;
                    }
                    tokio::fs::write(&path, &content).await.map_err(|error| format!("{path}: {error}"))?;
                    Ok(format!("wrote {} bytes to {path}", content.len()))
                })
            }),
        },
        Handler {
            name: "list_dir",
            description: "List the entries of a directory; directories end with a slash.",
            schema: json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }),
            run: Box::new(|input, _| {
                Box::pin(async move {
                    let path = text(&input, "path")?;
                    let mut entries = tokio::fs::read_dir(&path).await.map_err(|error| format!("{path}: {error}"))?;
                    let mut names = Vec::new();
                    while let Some(entry) = entries.next_entry().await.map_err(|error| error.to_string())? {
                        let dir = entry.file_type().await.is_ok_and(|kind| kind.is_dir());
                        names.push(format!("{}{}", entry.file_name().to_string_lossy(), if dir { "/" } else { "" }));
                    }
                    names.sort();
                    Ok(names.join("\n"))
                })
            }),
        },
        remember(memory, project, session),
    ];
    tools.into_iter().map(|tool| Arc::new(tool) as Arc<dyn Tool>).collect()
}

fn remember(memory: Arc<Memory>, project: String, session: String) -> Handler {
    Handler {
        name: "remember",
        description: "Store a fact for later. scope: `session` (this conversation), `project` (default, this directory) or `global` (everywhere). Writing an existing key replaces it; set pinned for rules that must always be recalled.",
        schema: json!({
            "type": "object",
            "properties": {
                "key": { "type": "string" },
                "text": { "type": "string" },
                "summary": { "type": "string" },
                "scope": { "type": "string", "enum": ["session", "project", "global"] },
                "pinned": { "type": "boolean" }
            },
            "required": ["key", "text"]
        }),
        run: Box::new(move |input, _| {
            let memory = memory.clone();
            let project = project.clone();
            let session = session.clone();
            Box::pin(async move {
                let key = text(&input, "key")?;
                let scope = match input["scope"].as_str().unwrap_or("project") {
                    "session" => Scope::Session(session),
                    "global" => Scope::Global,
                    "project" => Scope::Project(project),
                    other => return Err(format!("unknown scope `{other}`")),
                };
                let mut item = Item::new(&key, &text(&input, "text")?, now());
                item.summary = input["summary"].as_str().map(String::from);
                item.pinned = input["pinned"].as_bool().unwrap_or(false);
                memory.put(&scope, item).map_err(|error| error.to_string())?;
                Ok(format!("remembered `{key}`"))
            })
        }),
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}
