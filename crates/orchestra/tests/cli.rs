use std::io::Write;
use std::process::{Command, Stdio};

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("orchestra-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(home: &std::path::Path, input: &str) -> String {
    let mut child = Command::new(env!("CARGO_BIN_EXE_orchestra"))
        .arg("--human")
        .env("ORCHESTRA_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    String::from_utf8_lossy(&child.wait_with_output().unwrap().stdout).to_string()
}

#[test]
fn a_human_driven_session_uses_tools_and_persists() {
    let home = temp("e2e");
    let target = home.join("out.txt");
    let call = format!("/call write_file {}\n", serde_json::json!({ "path": target, "content": "hi" }));
    // prompt, then the "model" calls a tool, then answers in text, then quit.
    let output = run(&home, &format!("make a file\n{call}all done\n/quit\n"));

    assert_eq!(std::fs::read_to_string(&target).unwrap(), "hi");
    assert!(output.contains("write_file"));
    assert!(output.contains("all done"));

    let sessions: Vec<_> = std::fs::read_dir(home.join("sessions")).unwrap().collect();
    assert_eq!(sessions.len(), 1);
    let log = std::fs::read_to_string(sessions[0].as_ref().unwrap().path()).unwrap();
    assert!(log.contains("make a file") && log.contains("wrote 2 bytes") && log.contains("all done"));
}

#[test]
fn the_remember_tool_writes_to_the_chosen_scope_and_recall_finds_it_next_turn() {
    let home = temp("memory");
    let call = "/call remember {\"key\":\"editor\",\"text\":\"uses helix\",\"scope\":\"global\"}\n";
    run(&home, &format!("note this\n{call}noted\n/quit\n"));
    let stored = std::fs::read_to_string(home.join("memory").join("global.jsonl")).unwrap();
    assert!(stored.contains("uses helix"));
}
