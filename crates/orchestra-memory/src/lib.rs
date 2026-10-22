//! Scoped, elastic memory.
//!
//! Three scopes with strict precedence: a session remembers what only it needs, a project what
//! every session in it needs, and the global scope what the person needs everywhere. Each scope is
//! an append-only log folded last-write-wins, so a crash never loses more than the line being
//! written and compaction is an atomic rewrite.
//!
//! Recall is elastic: the caller gives a token budget and every memory is shown at the richest
//! level that still fits (full text, then summary, then a one-line index entry), so the same
//! store serves a tiny prompt and a huge one without any caller-side truncation logic.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    Global,
    Project(String),
    Session(String),
}

impl Scope {
    /// Higher wins when the same key exists in several scopes.
    fn rank(&self) -> u8 {
        match self {
            Scope::Global => 0,
            Scope::Project(_) => 1,
            Scope::Session(_) => 2,
        }
    }

    fn weight(&self) -> f64 {
        match self {
            Scope::Global => 1.0,
            Scope::Project(_) => 1.2,
            Scope::Session(_) => 1.5,
        }
    }

    fn file(&self) -> String {
        match self {
            Scope::Global => "global.jsonl".into(),
            Scope::Project(id) => format!("project-{}.jsonl", safe(id)),
            Scope::Session(id) => format!("session-{}.jsonl", safe(id)),
        }
    }
}

// Scope ids come from paths and user input; keep file names portable and collision-free.
fn safe(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_string() } else { format!("~{:x}", c as u32) })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub key: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Pinned items are never forgotten by compaction and are always recalled first.
    #[serde(default)]
    pub pinned: bool,
    /// Unix seconds of the last write.
    pub at: u64,
    /// How often recall found this useful; reinforces items that keep mattering.
    #[serde(default)]
    pub hits: u32,
}

impl Item {
    pub fn new(key: &str, text: &str, at: u64) -> Self {
        Self { key: key.into(), text: text.into(), summary: None, tags: Vec::new(), pinned: false, at, hits: 0 }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Line {
    Put { item: Item },
    Forget { key: String },
    Touch { key: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Full,
    Summary,
    Index,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub scope: Scope,
    pub key: String,
    pub level: Level,
    pub text: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct Recall {
    pub hits: Vec<Hit>,
    pub tokens: usize,
}

impl Recall {
    pub fn render(&self) -> String {
        self.hits
            .iter()
            .map(|hit| match hit.level {
                Level::Index => format!("- {} (ask for details)", hit.key),
                _ => format!("- {}: {}", hit.key, hit.text),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

const HALF_LIFE_SECONDS: f64 = 30.0 * 24.0 * 3600.0;
const MAX_INDEX_LINES: usize = 50;
const SUMMARY_FALLBACK_CHARS: usize = 160;

pub fn tokens(text: &str) -> usize {
    text.chars().count().div_ceil(4)
}

pub struct Memory {
    root: PathBuf,
}

impl Memory {
    pub fn open(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn put(&self, scope: &Scope, item: Item) -> std::io::Result<()> {
        self.append(scope, &Line::Put { item })
    }

    pub fn forget(&self, scope: &Scope, key: &str) -> std::io::Result<()> {
        self.append(scope, &Line::Forget { key: key.into() })
    }

    pub fn items(&self, scope: &Scope) -> Vec<Item> {
        let mut items: Vec<Item> = self.fold(scope).into_values().collect();
        items.sort_by(|a, b| a.key.cmp(&b.key));
        items
    }

    /// Rewrites a scope with only its live items. Atomic: the old log stays until the new one is in place.
    pub fn compact(&self, scope: &Scope) -> std::io::Result<()> {
        let path = self.root.join(scope.file());
        let temp = path.with_extension("jsonl.tmp");
        let mut file = fs::File::create(&temp)?;
        for item in self.items(scope) {
            writeln!(file, "{}", serde_json::to_string(&Line::Put { item }).expect("lines always serialize"))?;
        }
        file.sync_all()?;
        fs::rename(temp, path)
    }

    /// Picks what to show for `query` within `budget` tokens. `scopes` may list any mix; when a key
    /// exists in several, the narrowest scope wins. Recalled items are reinforced.
    pub fn recall(&self, scopes: &[Scope], query: &str, budget: usize, now: u64) -> std::io::Result<Recall> {
        let mut winners: HashMap<String, (Scope, Item)> = HashMap::new();
        for scope in scopes {
            for (key, item) in self.fold(scope) {
                if winners.get(&key).is_none_or(|(held, _)| held.rank() < scope.rank()) {
                    winners.insert(key, (scope.clone(), item));
                }
            }
        }

        let terms = words(query);
        let mut ranked: Vec<(f64, Scope, Item)> = winners
            .into_values()
            .map(|(scope, item)| (score(&item, &scope, &terms, now), scope, item))
            .filter(|(score, _, item)| item.pinned || *score > 0.0)
            .collect();
        ranked.sort_by(|a, b| {
            b.2.pinned
                .cmp(&a.2.pinned)
                .then(b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal))
                .then(a.2.key.cmp(&b.2.key))
        });

        let mut recall = Recall::default();
        let mut index_lines = 0;
        for (_, scope, item) in ranked {
            let full = tokens(&item.text) + tokens(&item.key) + 2;
            let summary_text = item
                .summary
                .clone()
                .unwrap_or_else(|| item.text.chars().take(SUMMARY_FALLBACK_CHARS).collect());
            let summary = tokens(&summary_text) + tokens(&item.key) + 2;
            let index = tokens(&item.key) + 6;
            let left = budget.saturating_sub(recall.tokens);
            let (level, text, cost) = if full <= left {
                (Level::Full, item.text.clone(), full)
            } else if summary <= left && summary < full {
                (Level::Summary, summary_text, summary)
            } else if index_lines < MAX_INDEX_LINES {
                index_lines += 1;
                (Level::Index, String::new(), index)
            } else {
                continue;
            };
            recall.tokens += cost;
            self.append(&scope, &Line::Touch { key: item.key.clone() })?;
            recall.hits.push(Hit { scope, key: item.key, level, text });
        }
        Ok(recall)
    }

    fn append(&self, scope: &Scope, line: &Line) -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new().create(true).append(true).open(self.root.join(scope.file()))?;
        writeln!(file, "{}", serde_json::to_string(line).expect("lines always serialize"))
    }

    fn fold(&self, scope: &Scope) -> HashMap<String, Item> {
        let mut items: HashMap<String, Item> = HashMap::new();
        let Ok(text) = fs::read_to_string(self.root.join(scope.file())) else { return items };
        // Unreadable lines (a torn write, a future format) are skipped; the rest of the log still counts.
        for line in text.lines().filter_map(|line| serde_json::from_str::<Line>(line).ok()) {
            match line {
                Line::Put { item } => {
                    let hits = items.get(&item.key).map_or(item.hits, |old| old.hits.max(item.hits));
                    items.insert(item.key.clone(), Item { hits, ..item });
                }
                Line::Forget { key } => {
                    // Pinned items resist forgetting; they must be unpinned by writing them again.
                    if items.get(&key).is_some_and(|item| !item.pinned) {
                        items.remove(&key);
                    }
                }
                Line::Touch { key } => {
                    if let Some(item) = items.get_mut(&key) {
                        item.hits = item.hits.saturating_add(1);
                    }
                }
            }
        }
        items
    }
}

fn words(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.chars().count() > 1)
        .filter(|word| seen.insert(word.to_string()))
        .map(String::from)
        .collect()
}

fn score(item: &Item, scope: &Scope, terms: &[String], now: u64) -> f64 {
    let age = now.saturating_sub(item.at) as f64;
    let recency = 0.5_f64.powf(age / HALF_LIFE_SECONDS);
    let reinforcement = 1.0 + (1.0 + item.hits as f64).ln() * 0.1;
    let base = scope.weight() * reinforcement * (0.25 + 0.75 * recency);
    if terms.is_empty() {
        return base;
    }
    let text = item.text.to_lowercase();
    let label = format!("{} {}", item.key.to_lowercase(), item.tags.join(" ").to_lowercase());
    let length = (words(&text).len().max(1) as f64).sqrt();
    let relevance: f64 = terms
        .iter()
        .map(|term| 3.0 * label.matches(term.as_str()).count() as f64 + text.matches(term.as_str()).count() as f64)
        .sum::<f64>()
        / length;
    base * relevance
}
