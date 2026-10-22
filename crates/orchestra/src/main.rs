mod config;
mod tools;
mod transports;

use futures::StreamExt;
use orchestra_kernel::{Event, Pool, Transport};
use orchestra_memory::{Item, Memory, Scope};
use orchestra_session::{Session, Store, Turn, drive};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use transports::{Compatible, Human};

// Two colors, contour only: cyan for structure, dim for everything secondary.
const LINE: &str = "\x1b[36m";
const DIM: &str = "\x1b[90m";
const OFF: &str = "\x1b[0m";

// Static dither band; `phase` shifts the pattern so it can be animated later without a rewrite.
fn dither(width: usize, phase: usize) -> String {
    const SHADES: [char; 4] = ['░', '▒', '▓', '▒'];
    (0..width).map(|column| SHADES[(column + phase) % SHADES.len()]).collect()
}

const SYSTEM: &str = "You are Orchestra, a capable agent working in the user's terminal. Use tools freely and keep going until the task is truly done. Use `remember` for facts worth keeping across sessions.";

fn home() -> PathBuf {
    if let Ok(path) = std::env::var("ORCHESTRA_HOME") {
        return path.into();
    }
    let base = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join(".local").join("share").join("orchestra")
}

fn transport(config: &config::Config, human: bool) -> (Arc<dyn Transport>, String) {
    if human || config.endpoints.is_empty() {
        return (Arc::new(Human), "human".into());
    }
    let transports: Vec<Arc<dyn Transport>> = config
        .endpoints
        .iter()
        .map(|endpoint| Arc::new(Compatible::new(&endpoint.base, endpoint.key.clone(), &endpoint.model)) as Arc<dyn Transport>)
        .collect();
    let pool = Pool::new(transports);
    let label = pool.id();
    (Arc::new(pool), label)
}

fn ask(question: &str, default: &str) -> String {
    print!("{LINE}│{OFF} {question}{} ", if default.is_empty() { String::new() } else { format!(" {DIM}[{default}]{OFF}") });
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    let line = line.trim();
    if line.is_empty() { default.to_string() } else { line.to_string() }
}

fn setup(home: &std::path::Path) {
    println!("{LINE}┌─ setup {DIM}{}{OFF}", dither(8, 0));
    println!("{LINE}│{OFF} Any server with an OpenAI-compatible API works: a hosted service with your key, a local runtime, a gateway.");
    let mut config = config::load(home);
    config.endpoints.clear();
    loop {
        let base = ask("base URL", "https://api.openai.com/v1");
        let key = ask("API key (empty if none)", "");
        let model = ask("model", "gpt-4o-mini");
        config.endpoints.push(config::Endpoint { base, key: (!key.is_empty()).then_some(key), model });
        if !ask("add a fallback endpoint? (y/N)", "n").to_lowercase().starts_with('y') {
            break;
        }
    }
    match config::save(home, &config) {
        Ok(()) => println!("{LINE}└{OFF} saved to {}", config::path(home).display()),
        Err(error) => println!("{LINE}└{OFF} cannot save: {error}"),
    }
}

fn flag(args: &[String], name: &str) -> Option<Option<String>> {
    args.iter().position(|arg| arg == name).map(|index| args.get(index + 1).cloned())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if flag(&args, "--help").is_some() {
        println!("orchestra [setup] [--human] [--session <id>] [--list]\n\n`orchestra setup` saves a model endpoint; env overrides it: ORCHESTRA_BASE_URL, ORCHESTRA_API_KEY, ORCHESTRA_MODEL (comma-separated lists form a failover pool), ORCHESTRA_HOME.\nIn the prompt: /new  /sessions  /memory  /remember <key> <text>  /forget <key>  /quit");
        return;
    }
    let root = home();
    if args.first().is_some_and(|arg| arg == "setup") {
        return setup(&root);
    }
    let (store, memory) = match (Store::open(root.join("sessions")).await, Memory::open(root.join("memory"))) {
        (Ok(store), Ok(memory)) => (store, Arc::new(memory)),
        (Err(error), _) => return eprintln!("cannot open {}: {error}", root.display()),
        (_, Err(error)) => return eprintln!("cannot open {}: {error}", root.display()),
    };
    if flag(&args, "--list").is_some() {
        for id in store.list().await.unwrap_or_default() {
            println!("{id}");
        }
        return;
    }

    let project = std::env::current_dir().map(|path| path.display().to_string()).unwrap_or_else(|_| ".".into());
    let config = config::resolve(config::load(&root), |name| std::env::var(name).ok());
    let (transport, label) = transport(&config, flag(&args, "--human").is_some());
    if config.endpoints.is_empty() && flag(&args, "--human").is_none() {
        println!("{DIM}no model configured: you answer as the model. Run `orchestra setup` to connect one.{OFF}");
    }
    let mut session = match flag(&args, "--session").flatten() {
        Some(id) => match Session::open(&store, &id).await {
            Ok(session) => session,
            Err(error) => return eprintln!("{error}"),
        },
        None => new_session(&store).await,
    };

    println!("{LINE}┌─ orchestra {DIM}{}{LINE} ─{OFF} {label} {DIM}· {} · {}{OFF}", dither(8, 0), session.id, project);
    loop {
        let read = tokio::task::spawn_blocking(|| {
            print!("{LINE}│{OFF} > ");
            let _ = std::io::stdout().flush();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).map(|read| (read, line))
        })
        .await;
        let Ok(Ok((read, line))) = read else { break };
        let line = line.trim().to_string();
        if read == 0 || line == "/quit" {
            break;
        }
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('/') {
            command(rest, &store, &memory, &project, &mut session).await;
            continue;
        }

        let scopes = [Scope::Global, Scope::Project(project.clone()), Scope::Session(session.id.clone())];
        let recalled = memory.recall(&scopes, &line, 800, tools::now()).map(|recall| recall.render()).unwrap_or_default();
        let system = if recalled.is_empty() { SYSTEM.to_string() } else { format!("{SYSTEM}\n\nMemory:\n{recalled}") };

        let cancel = CancellationToken::new();
        let interrupt = cancel.clone();
        let watcher = tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                interrupt.cancel();
            }
        });
        let turn = Turn {
            store: store.clone(),
            session: session.clone(),
            transport: transport.clone(),
            tools: tools::all(memory.clone(), project.clone(), session.id.clone()),
            system: Some(system),
            cancel,
        };
        let mut events = drive(turn, line);
        let mut at_line_start = true;
        while let Some(event) = events.next().await {
            let lead = if at_line_start { "" } else { "\n" };
            match event {
                Ok(Event::Text(delta)) => {
                    for part in delta.split_inclusive('\n') {
                        if at_line_start {
                            print!("{LINE}│{OFF} ");
                        }
                        print!("{part}");
                        at_line_start = part.ends_with('\n');
                    }
                    let _ = std::io::stdout().flush();
                }
                Ok(Event::Call(call)) => {
                    println!("{lead}{LINE}│ {DIM}⚙ {} {}{OFF}", call.name, call.input);
                    at_line_start = true;
                }
                Ok(Event::Result { output, .. }) => {
                    let first = output.lines().next().unwrap_or("");
                    println!("{lead}{LINE}│ {DIM}↳ {first}{}{OFF}", if output.lines().count() > 1 { " …" } else { "" });
                    at_line_start = true;
                }
                Ok(Event::Wait { ms, reason }) => {
                    println!("{lead}{LINE}│ {DIM}{} waiting {}s: {reason}{OFF}", dither(3, 0), ms / 1000);
                    at_line_start = true;
                }
                Ok(Event::Assistant { .. }) | Ok(Event::Done(_)) => {}
                Err(error) => {
                    println!("{lead}{LINE}│ ✗ {error}{OFF}");
                    at_line_start = true;
                }
            }
        }
        if !at_line_start {
            println!();
        }
        watcher.abort();
        if let Ok(reloaded) = Session::open(&store, &session.id).await {
            session = reloaded;
        }
    }
    println!("{LINE}└{}{OFF}", dither(24, 0));
}

async fn new_session(store: &Store) -> Session {
    let id = format!("s{}", tools::now());
    Session::create(store, &id, "untitled").await.expect("cannot create a session")
}

async fn command(rest: &str, store: &Store, memory: &Memory, project: &str, session: &mut Session) {
    let (name, argument) = rest.split_once(' ').unwrap_or((rest, ""));
    match name {
        "new" => *session = new_session(store).await,
        "sessions" => {
            for id in store.list().await.unwrap_or_default() {
                println!("{LINE}│{OFF} {id}");
            }
        }
        "memory" => {
            let scopes = [("global", Scope::Global), ("project", Scope::Project(project.into())), ("session", Scope::Session(session.id.clone()))];
            for (label, scope) in scopes {
                for item in memory.items(&scope) {
                    println!("{LINE}│{OFF} {DIM}{label}{OFF} {}: {}", item.key, item.text);
                }
            }
        }
        "remember" => match argument.split_once(' ') {
            Some((key, text)) => {
                let _ = memory.put(&Scope::Project(project.into()), Item::new(key, text, tools::now()));
                println!("{LINE}│{OFF} remembered {key}");
            }
            None => println!("{LINE}│{OFF} usage: /remember <key> <text>"),
        },
        "forget" => {
            let _ = memory.forget(&Scope::Project(project.into()), argument);
        }
        _ => println!("{LINE}│{OFF} unknown command /{name}"),
    }
}
