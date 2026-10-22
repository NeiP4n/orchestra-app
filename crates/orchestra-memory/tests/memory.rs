use orchestra_memory::{Item, Level, Memory, Scope, tokens};

fn open(name: &str) -> Memory {
    let dir = std::env::temp_dir().join(format!("orchestra-memory-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    Memory::open(dir).unwrap()
}

const NOW: u64 = 1_800_000_000;
const DAY: u64 = 86_400;

fn project() -> Scope {
    Scope::Project("/work/app".into())
}

#[test]
fn the_narrowest_scope_wins_for_the_same_key() {
    let memory = open("precedence");
    memory.put(&Scope::Global, Item::new("style", "global tabs", NOW)).unwrap();
    memory.put(&project(), Item::new("style", "project spaces", NOW)).unwrap();
    let session = Scope::Session("s1".into());
    memory.put(&session, Item::new("style", "session semicolons", NOW)).unwrap();

    let all = [Scope::Global, project(), session.clone()];
    let recall = memory.recall(&all, "style", 1000, NOW).unwrap();
    assert_eq!(recall.hits.len(), 1);
    assert_eq!(recall.hits[0].text, "session semicolons");
    assert_eq!(recall.hits[0].scope, session);

    let without_session = memory.recall(&all[..2], "style", 1000, NOW).unwrap();
    assert_eq!(without_session.hits[0].text, "project spaces");
}

#[test]
fn scopes_do_not_leak_into_each_other() {
    let memory = open("isolation");
    memory.put(&Scope::Project("a".into()), Item::new("secret", "only in a", NOW)).unwrap();
    let recall = memory.recall(&[Scope::Global, Scope::Project("b".into())], "secret", 1000, NOW).unwrap();
    assert!(recall.hits.is_empty());
}

#[test]
fn recall_shrinks_detail_instead_of_dropping_when_the_budget_is_small() {
    let memory = open("elastic");
    let long = "database migrations run through the release script ".repeat(40);
    let mut item = Item::new("migrations", &long, NOW);
    item.summary = Some("migrations run via release script".into());
    memory.put(&Scope::Global, item).unwrap();
    let scopes = [Scope::Global];

    let roomy = memory.recall(&scopes, "migrations", 10_000, NOW).unwrap();
    assert_eq!(roomy.hits[0].level, Level::Full);

    let tight = memory.recall(&scopes, "migrations", 30, NOW).unwrap();
    assert_eq!(tight.hits[0].level, Level::Summary);
    assert_eq!(tight.hits[0].text, "migrations run via release script");

    let tiny = memory.recall(&scopes, "migrations", 8, NOW).unwrap();
    assert_eq!(tiny.hits[0].level, Level::Index);
    assert!(tiny.render().contains("migrations"));
}

#[test]
fn the_total_never_exceeds_the_budget_except_for_index_lines() {
    let memory = open("budget");
    for index in 0..30 {
        memory.put(&Scope::Global, Item::new(&format!("note{index}"), &"deploy ".repeat(50), NOW)).unwrap();
    }
    let recall = memory.recall(&[Scope::Global], "deploy", 200, NOW).unwrap();
    let full_cost: usize = recall.hits.iter().filter(|hit| hit.level != Level::Index).map(|hit| tokens(&hit.text) + 4).sum();
    assert!(full_cost <= 200 + recall.hits.len() * 3);
    assert!(recall.hits.iter().any(|hit| hit.level == Level::Index));
}

#[test]
fn relevant_and_recent_items_come_first() {
    let memory = open("ranking");
    memory.put(&Scope::Global, Item::new("old", "rust build flags", NOW - 400 * DAY)).unwrap();
    memory.put(&Scope::Global, Item::new("new", "rust build flags", NOW)).unwrap();
    memory.put(&Scope::Global, Item::new("other", "cooking pasta", NOW)).unwrap();
    let recall = memory.recall(&[Scope::Global], "rust build", 1000, NOW).unwrap();
    let keys: Vec<&str> = recall.hits.iter().map(|hit| hit.key.as_str()).collect();
    assert_eq!(keys, ["new", "old"]);
}

#[test]
fn pinned_items_are_always_recalled_first_and_cannot_be_forgotten() {
    let memory = open("pinned");
    let mut rule = Item::new("rule", "never push to main", NOW - 900 * DAY);
    rule.pinned = true;
    memory.put(&Scope::Global, rule).unwrap();
    memory.put(&Scope::Global, Item::new("topic", "pushing releases", NOW)).unwrap();
    memory.forget(&Scope::Global, "rule").unwrap();

    let recall = memory.recall(&[Scope::Global], "pushing", 1000, NOW).unwrap();
    assert_eq!(recall.hits[0].key, "rule");
    assert_eq!(recall.hits.len(), 2);
}

#[test]
fn forgetting_removes_an_item_and_compaction_keeps_only_live_ones() {
    let memory = open("compact");
    for index in 0..5 {
        memory.put(&Scope::Global, Item::new("k", &format!("version {index}"), NOW + index)).unwrap();
    }
    memory.put(&Scope::Global, Item::new("gone", "bye", NOW)).unwrap();
    memory.forget(&Scope::Global, "gone").unwrap();
    memory.compact(&Scope::Global).unwrap();

    let items = memory.items(&Scope::Global);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].text, "version 4");
}

#[test]
fn recall_reinforces_and_a_torn_line_does_not_lose_the_rest() {
    let memory = open("reinforce");
    memory.put(&Scope::Global, Item::new("a", "alpha topic", NOW)).unwrap();
    memory.recall(&[Scope::Global], "alpha", 1000, NOW).unwrap();
    memory.recall(&[Scope::Global], "alpha", 1000, NOW).unwrap();
    assert_eq!(memory.items(&Scope::Global)[0].hits, 2);

    let dir = std::env::temp_dir().join(format!("orchestra-memory-reinforce-{}", std::process::id()));
    let path = dir.join("global.jsonl");
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str("{\"op\":\"pu");
    std::fs::write(&path, text).unwrap();
    assert_eq!(memory.items(&Scope::Global).len(), 1);
}

#[test]
fn awkward_scope_ids_map_to_distinct_safe_files() {
    let memory = open("names");
    memory.put(&Scope::Project("C:\\work\\a".into()), Item::new("k", "one", NOW)).unwrap();
    memory.put(&Scope::Project("C:/work/a".into()), Item::new("k", "two", NOW)).unwrap();
    assert_eq!(memory.items(&Scope::Project("C:\\work\\a".into()))[0].text, "one");
    assert_eq!(memory.items(&Scope::Project("C:/work/a".into()))[0].text, "two");
}
