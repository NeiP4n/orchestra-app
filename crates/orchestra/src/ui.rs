//! The full-screen interface.
//!
//! One rounded frame, three colors (ink, cyan for structure, amber for what needs you), no fills.
//! Everything is on one screen: header, a tab row, the conversation, a dither rule, the input line
//! and, in the bottom border, the keys that matter right now. A tool call and its result share one
//! line, so a long agent run reads as a short list instead of a wall.
use crate::tools;
use crossterm::event::{Event as Term, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures::StreamExt;
use orchestra_kernel::{Event, Message, Transport, TransportError};
use orchestra_memory::{Item, Memory, Scope};
use orchestra_session::{Session, Store, Turn, drive};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Paragraph};
use ratatui::{DefaultTerminal, Frame};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use unicode_width::UnicodeWidthChar;

const CYAN: Color = Color::Cyan;
const AMBER: Color = Color::Rgb(255, 180, 84);
const DIM: Color = Color::DarkGray;

pub const QUICK: [&str; 3] = ["продолжай", "проверь тестами", "кратко итог"];
const COMMANDS: [&str; 7] = ["/new", "/close", "/memory", "/remember", "/forget", "/help", "/quit"];

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    User(String),
    Assistant(String),
    Tool { id: String, name: String, input: String, result: Option<String> },
    Wait(String),
    Error(String),
    Note(String),
}

pub struct Tab {
    pub session: Session,
    pub rows: Vec<Row>,
    pub busy: bool,
    /// Rows hidden below the window: 0 follows the newest output.
    pub scroll: usize,
}

impl Tab {
    pub fn new(session: Session) -> Self {
        let rows = rows_from(&session.messages);
        Self { session, rows, busy: false, scroll: 0 }
    }

    fn title(&self) -> String {
        let first = self.rows.iter().find_map(|row| match row {
            Row::User(text) => Some(text.as_str()),
            _ => None,
        });
        let title = first.unwrap_or("новая");
        let short: String = title.chars().take(14).collect();
        if title.chars().count() > 14 { format!("{short}…") } else { short }
    }
}

pub fn rows_from(messages: &[Message]) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    for message in messages {
        match message {
            Message::User { text } => rows.push(Row::User(text.clone())),
            Message::Assistant { text, calls } => {
                if !text.trim().is_empty() {
                    rows.push(Row::Assistant(text.clone()));
                }
                for call in calls {
                    rows.push(Row::Tool { id: call.id.clone(), name: call.name.clone(), input: call.input.clone(), result: None });
                }
            }
            Message::Tool { id, output } => {
                for row in rows.iter_mut() {
                    if let Row::Tool { id: row_id, result, .. } = row
                        && row_id == id
                    {
                        *result = Some(summary(output));
                    }
                }
            }
        }
    }
    rows
}

fn summary(output: &str) -> String {
    let first = output.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    let clipped: String = first.chars().take(120).collect();
    let more = output.lines().filter(|line| !line.trim().is_empty()).count() > 1 || first.chars().count() > 120;
    if more { format!("{clipped} …") } else { clipped }
}

/// Folds one agent event into the tab.
pub fn apply(tab: &mut Tab, event: Result<Event, TransportError>) {
    if !matches!(event, Ok(Event::Wait { .. })) && matches!(tab.rows.last(), Some(Row::Wait(_))) {
        tab.rows.pop();
    }
    match event {
        Ok(Event::Text(delta)) => match tab.rows.last_mut() {
            Some(Row::Assistant(text)) => text.push_str(&delta),
            _ => tab.rows.push(Row::Assistant(delta)),
        },
        Ok(Event::Call(call)) => tab.rows.push(Row::Tool { id: call.id, name: call.name, input: call.input, result: None }),
        Ok(Event::Result { id, output }) => {
            for row in tab.rows.iter_mut() {
                if let Row::Tool { id: row_id, result, .. } = row
                    && *row_id == id
                {
                    *result = Some(summary(&output));
                }
            }
        }
        Ok(Event::Wait { ms, reason }) => {
            let text = format!("жду {} с: {reason}", ms / 1000);
            match tab.rows.last_mut() {
                Some(Row::Wait(old)) => *old = text,
                _ => tab.rows.push(Row::Wait(text)),
            }
        }
        Ok(Event::Assistant { .. }) | Ok(Event::Done(_)) => {}
        Err(error) => tab.rows.push(Row::Error(error.to_string())),
    }
}

#[derive(Debug, PartialEq)]
pub enum Action {
    Submit(String),
    Command(String),
    Cancel,
    NewTab,
    CloseTab,
    Quit,
}

pub struct App {
    pub tabs: Vec<Tab>,
    pub active: usize,
    pub input: String,
    pub header: String,
    pub phase: usize,
    pub quit: bool,
}

impl App {
    pub fn new(first: Session, header: String) -> Self {
        Self { tabs: vec![Tab::new(first)], active: 0, input: String::new(), header, phase: 0, quit: false }
    }

    pub fn tab(&self) -> &Tab {
        &self.tabs[self.active]
    }

    fn tab_mut(&mut self) -> &mut Tab {
        &mut self.tabs[self.active]
    }

    pub fn any_busy(&self) -> bool {
        self.tabs.iter().any(|tab| tab.busy)
    }

    /// Quick replies are offered when the agent has just finished and nothing is typed.
    pub fn quick_visible(&self) -> bool {
        !self.tab().busy && self.input.is_empty() && matches!(self.tab().rows.last(), Some(Row::Assistant(_)))
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Option<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        match key.code {
            KeyCode::Char('c') if ctrl => Some(if self.tab().busy { Action::Cancel } else { Action::Quit }),
            KeyCode::Esc if self.tab().busy => Some(Action::Cancel),
            KeyCode::Char('n') if ctrl => Some(Action::NewTab),
            KeyCode::Char('w') if ctrl => Some(Action::CloseTab),
            KeyCode::Char('u') if ctrl => {
                self.input.clear();
                None
            }
            KeyCode::Left if alt => {
                self.active = (self.active + self.tabs.len() - 1) % self.tabs.len();
                None
            }
            KeyCode::Right if alt => {
                self.active = (self.active + 1) % self.tabs.len();
                None
            }
            KeyCode::Char(digit @ '1'..='3') if alt => {
                let reply = QUICK[digit as usize - '1' as usize];
                self.quick_visible().then(|| Action::Submit(reply.to_string()))
            }
            KeyCode::PageUp => {
                self.tab_mut().scroll += 8;
                None
            }
            KeyCode::PageDown => {
                let tab = self.tab_mut();
                tab.scroll = tab.scroll.saturating_sub(8);
                None
            }
            KeyCode::Enter => {
                let text = self.input.trim().to_string();
                if text.is_empty() {
                    return None;
                }
                if text == "/quit" {
                    return Some(Action::Quit);
                }
                if text.starts_with('/') {
                    self.input.clear();
                    return Some(Action::Command(text));
                }
                // A running turn owns the conversation; the text stays in the box for when it ends.
                if self.tab().busy {
                    return None;
                }
                self.input.clear();
                Some(Action::Submit(text))
            }
            KeyCode::Backspace => {
                self.input.pop();
                None
            }
            KeyCode::Char(ch) if !ctrl && !alt => {
                self.input.push(ch);
                None
            }
            _ => None,
        }
    }
}

// ---------------------------------------------------------------- view

pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut out = Vec::new();
    for line in text.split('\n') {
        let mut current = String::new();
        let mut used = 0;
        let mut last_space: Option<(usize, usize)> = None; // (byte index, width before it)
        for ch in line.chars() {
            let w = ch.width().unwrap_or(0);
            if used + w > width && used > 0 && ch == ' ' {
                out.push(std::mem::take(&mut current));
                used = 0;
                last_space = None;
                continue;
            }
            if used + w > width && used > 0 {
                match last_space.take() {
                    Some((at, _)) if at > 0 => {
                        let rest = current.split_off(at);
                        out.push(current.trim_end().to_string());
                        current = rest.trim_start().to_string();
                        used = current.chars().map(|c| c.width().unwrap_or(0)).sum();
                    }
                    _ => {
                        out.push(std::mem::take(&mut current));
                        used = 0;
                    }
                }
            }
            if ch == ' ' {
                last_space = Some((current.len(), used));
            }
            current.push(ch);
            used += w;
        }
        out.push(current);
    }
    out
}

fn clip(text: &str, width: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in text.chars() {
        let w = ch.width().unwrap_or(0);
        if used + w > width.saturating_sub(1) {
            out.push('…');
            return out;
        }
        out.push(ch);
        used += w;
    }
    out
}

fn dither(width: usize, phase: usize) -> String {
    const SHADES: [char; 4] = ['░', '▒', '▓', '▒'];
    (0..width).map(|column| SHADES[(column + phase) % SHADES.len()]).collect()
}

fn lines_for(tab: &Tab, width: usize, phase: usize) -> Vec<Line<'static>> {
    let cyan = Style::default().fg(CYAN);
    let dim = Style::default().fg(DIM);
    let amber = Style::default().fg(AMBER);
    let mut lines: Vec<Line<'static>> = Vec::new();
    for (index, row) in tab.rows.iter().enumerate() {
        match row {
            Row::User(text) => {
                if index > 0 {
                    lines.push(Line::default());
                }
                for (n, part) in wrap(text, width.saturating_sub(2)).into_iter().enumerate() {
                    let lead = if n == 0 { "› " } else { "  " };
                    lines.push(Line::from(vec![Span::styled(lead, cyan), Span::styled(part, cyan.add_modifier(Modifier::BOLD))]));
                }
            }
            Row::Assistant(text) => {
                for part in wrap(text.trim_end(), width.saturating_sub(2)) {
                    lines.push(Line::from(format!("  {part}")));
                }
            }
            Row::Tool { name, input, result, .. } => {
                let call = format!("{name} {input}");
                let tail = match result {
                    Some(result) => format!("  ↳ {result}"),
                    None => "  …".to_string(),
                };
                let text = clip(&format!("⚙ {call}{tail}"), width.saturating_sub(2));
                let style = if result.is_none() { cyan } else { dim };
                lines.push(Line::from(vec![Span::raw("  "), Span::styled(text, style)]));
            }
            Row::Wait(text) => lines.push(Line::from(vec![Span::raw("  "), Span::styled(format!("{} {text}", dither(3, phase)), amber)])),
            Row::Error(text) => {
                for (n, part) in wrap(text, width.saturating_sub(4)).into_iter().enumerate() {
                    lines.push(Line::from(vec![Span::raw("  "), Span::styled(format!("{}{part}", if n == 0 { "✗ " } else { "  " }), amber)]));
                }
            }
            Row::Note(text) => {
                for part in wrap(text, width.saturating_sub(2)) {
                    lines.push(Line::from(vec![Span::raw("  "), Span::styled(part, dim)]));
                }
            }
        }
    }
    lines
}

pub fn draw(frame: &mut Frame, app: &App) {
    let cyan = Style::default().fg(CYAN);
    let dim = Style::default().fg(DIM);
    let amber = Style::default().fg(AMBER);
    let busy = app.any_busy();

    let status = if busy {
        Line::from(vec![Span::styled(format!(" {} работает ", dither(3, app.phase)), amber)])
    } else {
        Line::from(Span::styled(" готов ", dim))
    };
    let title = Line::from(vec![
        Span::styled(" orchestra ", cyan.add_modifier(Modifier::BOLD)),
        Span::styled(dither(3, if busy { app.phase } else { 0 }), dim),
        Span::styled(format!(" {} ", app.header), dim),
    ]);
    let hints = if busy {
        " Esc прервать · Alt+←→ вкладки "
    } else if app.quick_visible() {
        " Enter отправить · Alt+1‑3 быстрый ответ · Ctrl+N вкладка "
    } else {
        " Enter отправить · Ctrl+N вкладка · Ctrl+W закрыть · / команды "
    };
    let hints = if frame.area().width < 72 { if busy { " Esc прервать " } else { " Enter · Ctrl+N · / " } } else { hints };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(cyan)
        .title(title)
        .title(status.right_aligned())
        .title_bottom(Line::from(Span::styled(hints, dim)));
    let inner = block.inner(frame.area());
    frame.render_widget(block, frame.area());

    let [tabs_area, body, rule, input_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(inner);

    // Tabs: the current one is bracketed in cyan, a working one carries an amber mark.
    let mut spans: Vec<Span> = vec![Span::raw(" ")];
    for (index, tab) in app.tabs.iter().enumerate() {
        let mark = if tab.busy { "…" } else { "" };
        let label = format!("{} {}{}", index + 1, tab.title(), mark);
        if index == app.active {
            spans.push(Span::styled(format!("[{label}]"), cyan.add_modifier(Modifier::BOLD)));
        } else {
            spans.push(Span::styled(label, if tab.busy { amber } else { dim }));
        }
        spans.push(Span::styled(" │ ", dim));
    }
    spans.push(Span::styled("+", dim));
    frame.render_widget(Paragraph::new(Line::from(spans)), tabs_area);

    // Conversation, anchored to the newest line unless the person scrolled up.
    let tab = app.tab();
    let mut lines = lines_for(tab, body.width as usize, app.phase);
    if lines.is_empty() {
        lines = vec![
            Line::from(Span::styled("  Напишите задачу ниже и нажмите Enter.", dim)),
            Line::from(Span::styled("  /help — команды, Ctrl+N — новая вкладка.", dim)),
        ];
    }
    let height = body.height as usize;
    let hidden = tab.scroll.min(lines.len().saturating_sub(height));
    let end = lines.len() - hidden;
    let start = end.saturating_sub(height);
    frame.render_widget(Paragraph::new(lines[start..end].to_vec()), body);

    // The rule is texture; when it has something to say it says it (commands, unread output).
    let width = rule.width as usize;
    let rule_line = if app.input.starts_with('/') {
        let matches: Vec<&str> = COMMANDS.iter().copied().filter(|command| command.starts_with(app.input.split(' ').next().unwrap_or(""))).collect();
        Line::from(Span::styled(format!(" {}", matches.join("  ")), cyan))
    } else if hidden > 0 {
        let label = format!(" ↓ ещё {hidden} ");
        let fill = width.saturating_sub(label.chars().count());
        Line::from(vec![Span::styled(dither(fill, 0), dim), Span::styled(label, amber)])
    } else {
        Line::from(Span::styled(dither(width, if busy { app.phase } else { 0 }), dim))
    };
    frame.render_widget(Paragraph::new(rule_line), rule);

    // Input line, with the quick replies on the right while they are on offer.
    let quick = if app.quick_visible() {
        QUICK.iter().enumerate().map(|(n, reply)| format!("[{} {reply}]", n + 1)).collect::<Vec<_>>().join(" ")
    } else {
        String::new()
    };
    let quick_width = (quick.chars().count() as u16 + 1).min(input_area.width / 2);
    let [typed_area, quick_area] = Layout::horizontal([Constraint::Min(4), Constraint::Length(quick_width)]).areas(input_area);
    let room = (typed_area.width as usize).saturating_sub(3);
    let mut shown: Vec<char> = app.input.chars().collect();
    let mut used: usize = shown.iter().map(|c| c.width().unwrap_or(0)).sum();
    while used > room && !shown.is_empty() {
        used -= shown.remove(0).width().unwrap_or(0);
    }
    let shown: String = shown.into_iter().collect();
    frame.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(" › ", cyan), Span::raw(shown.clone())])),
        typed_area,
    );
    if !quick.is_empty() {
        frame.render_widget(Paragraph::new(Line::from(Span::styled(quick, cyan))), quick_area);
    }
    let cursor_x = typed_area.x + 3 + shown.chars().map(|c| c.width().unwrap_or(0) as u16).sum::<u16>();
    frame.set_cursor_position((cursor_x.min(typed_area.right().saturating_sub(1)), typed_area.y));
    let _ = Rect::default();
}

// ---------------------------------------------------------------- loop

pub struct Ctx {
    pub store: Store,
    pub memory: Arc<Memory>,
    pub transport: Arc<dyn Transport>,
    pub project: String,
    pub base_system: String,
}

enum Msg {
    Agent(String, Result<Event, TransportError>),
    Finished(String),
}

pub async fn run(ctx: Ctx, first: Session, header: String) -> std::io::Result<()> {
    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, ctx, first, header).await;
    ratatui::restore();
    result
}

async fn event_loop(terminal: &mut DefaultTerminal, ctx: Ctx, first: Session, header: String) -> std::io::Result<()> {
    let mut app = App::new(first, header);
    let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
    let mut cancels: HashMap<String, CancellationToken> = HashMap::new();
    let mut keys = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(125));
    let mut dirty = true;

    loop {
        if dirty {
            terminal.draw(|frame| draw(frame, &app))?;
            dirty = false;
        }
        tokio::select! {
            Some(Ok(event)) = keys.next() => match event {
                Term::Key(key) if key.kind == KeyEventKind::Press => {
                    dirty = true;
                    if let Some(action) = app.on_key(key) {
                        perform(action, &mut app, &ctx, &tx, &mut cancels).await;
                    }
                }
                Term::Resize(..) => dirty = true,
                _ => {}
            },
            Some(message) = rx.recv() => {
                dirty = true;
                match message {
                    Msg::Agent(id, event) => {
                        if let Some(tab) = app.tabs.iter_mut().find(|tab| tab.session.id == id) {
                            apply(tab, event);
                        }
                    }
                    Msg::Finished(id) => {
                        cancels.remove(&id);
                        if let Ok(session) = Session::open(&ctx.store, &id).await
                            && let Some(tab) = app.tabs.iter_mut().find(|tab| tab.session.id == id)
                        {
                            tab.session = session;
                        }
                        if let Some(tab) = app.tabs.iter_mut().find(|tab| tab.session.id == id) {
                            tab.busy = false;
                        }
                    }
                }
            }
            _ = tick.tick() => {
                // The only animation is the working indicator, and it stops with the work.
                if app.any_busy() {
                    app.phase = app.phase.wrapping_add(1);
                    dirty = true;
                }
            }
        }
        if app.quit {
            for token in cancels.values() {
                token.cancel();
            }
            return Ok(());
        }
    }
}

async fn perform(action: Action, app: &mut App, ctx: &Ctx, tx: &mpsc::UnboundedSender<Msg>, cancels: &mut HashMap<String, CancellationToken>) {
    match action {
        Action::Quit => app.quit = true,
        Action::Cancel => {
            if let Some(token) = cancels.get(&app.tab().session.id) {
                token.cancel();
            }
        }
        Action::NewTab => {
            let session = crate::new_session(&ctx.store).await;
            app.tabs.push(Tab::new(session));
            app.active = app.tabs.len() - 1;
        }
        Action::CloseTab => {
            if app.tabs.len() > 1 {
                let tab = app.tabs.remove(app.active);
                if let Some(token) = cancels.remove(&tab.session.id) {
                    token.cancel();
                }
                app.active = app.active.min(app.tabs.len() - 1);
            }
        }
        Action::Command(text) => command(&text, app, ctx).await,
        Action::Submit(text) => {
            let project = ctx.project.clone();
            let tab = &mut app.tabs[app.active];
            tab.rows.push(Row::User(text.clone()));
            tab.busy = true;
            tab.scroll = 0;
            let id = tab.session.id.clone();
            let cancel = CancellationToken::new();
            cancels.insert(id.clone(), cancel.clone());

            let scopes = [Scope::Global, Scope::Project(project.clone()), Scope::Session(id.clone())];
            let recalled = ctx.memory.recall(&scopes, &text, 800, tools::now()).map(|recall| recall.render()).unwrap_or_default();
            let system = if recalled.is_empty() { ctx.base_system.clone() } else { format!("{}\n\nMemory:\n{recalled}", ctx.base_system) };
            let turn = Turn {
                store: ctx.store.clone(),
                session: tab.session.clone(),
                transport: ctx.transport.clone(),
                tools: tools::all(ctx.memory.clone(), project, id.clone()),
                system: Some(system),
                cancel,
            };
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut events = drive(turn, text);
                while let Some(event) = events.next().await {
                    if tx.send(Msg::Agent(id.clone(), event)).is_err() {
                        return;
                    }
                }
                let _ = tx.send(Msg::Finished(id));
            });
        }
    }
}

async fn command(text: &str, app: &mut App, ctx: &Ctx) {
    let (name, argument) = text.split_once(' ').unwrap_or((text, ""));
    let note = match name {
        "/new" => {
            let session = crate::new_session(&ctx.store).await;
            app.tabs.push(Tab::new(session));
            app.active = app.tabs.len() - 1;
            return;
        }
        "/close" => {
            if app.tabs.len() > 1 {
                app.tabs.remove(app.active);
                app.active = app.active.min(app.tabs.len() - 1);
            }
            return;
        }
        "/help" => "Enter — отправить · Alt+1‑3 — быстрые ответы · Alt+←→ — вкладки · Ctrl+N/W — открыть/закрыть вкладку · PgUp/PgDn — прокрутка · Esc — прервать · /memory /remember <ключ> <текст> /forget <ключ> /new /close /quit".to_string(),
        "/memory" => {
            let scopes = [("global", Scope::Global), ("project", Scope::Project(ctx.project.clone())), ("session", Scope::Session(app.tab().session.id.clone()))];
            let items: Vec<String> = scopes
                .into_iter()
                .flat_map(|(label, scope)| ctx.memory.items(&scope).into_iter().map(move |item| format!("{label} {}: {}", item.key, item.text)))
                .collect();
            if items.is_empty() { "память пуста".to_string() } else { items.join("\n") }
        }
        "/remember" => match argument.split_once(' ') {
            Some((key, value)) => {
                let _ = ctx.memory.put(&Scope::Project(ctx.project.clone()), Item::new(key, value, tools::now()));
                format!("запомнил {key}")
            }
            None => "использование: /remember <ключ> <текст>".to_string(),
        },
        "/forget" => {
            let _ = ctx.memory.forget(&Scope::Project(ctx.project.clone()), argument);
            format!("забыл {argument}")
        }
        other => format!("неизвестная команда {other}"),
    };
    app.tabs[app.active].rows.push(Row::Note(note));
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchestra_kernel::ToolCall;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn session(messages: Vec<Message>) -> Session {
        Session { id: "s1".into(), title: "t".into(), messages }
    }

    fn app_with(messages: Vec<Message>) -> App {
        App::new(session(messages), "proj · test".into())
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn mods(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    fn render(app: &App, width: u16, height: u16) -> (Vec<String>, bool) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        let rows = (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>()).collect();
        let no_fill = buffer.content().iter().all(|cell| cell.bg == Color::Reset);
        (rows, no_fill)
    }

    fn type_text(app: &mut App, text: &str) {
        for ch in text.chars() {
            app.on_key(key(KeyCode::Char(ch)));
        }
    }

    #[test]
    fn typing_then_enter_submits_and_clears_the_box() {
        let mut app = app_with(vec![]);
        type_text(&mut app, "привет");
        assert_eq!(app.on_key(key(KeyCode::Enter)), Some(Action::Submit("привет".into())));
        assert!(app.input.is_empty());
        assert_eq!(app.on_key(key(KeyCode::Enter)), None);
    }

    #[test]
    fn a_running_turn_keeps_the_typed_text_and_ctrl_c_cancels_before_it_quits() {
        let mut app = app_with(vec![]);
        app.tabs[0].busy = true;
        type_text(&mut app, "ещё");
        assert_eq!(app.on_key(key(KeyCode::Enter)), None);
        assert_eq!(app.input, "ещё");
        assert_eq!(app.on_key(mods(KeyCode::Char('c'), KeyModifiers::CONTROL)), Some(Action::Cancel));
        app.tabs[0].busy = false;
        assert_eq!(app.on_key(mods(KeyCode::Char('c'), KeyModifiers::CONTROL)), Some(Action::Quit));
    }

    #[test]
    fn slash_commands_are_routed_and_quit_is_immediate() {
        let mut app = app_with(vec![]);
        type_text(&mut app, "/memory");
        assert_eq!(app.on_key(key(KeyCode::Enter)), Some(Action::Command("/memory".into())));
        type_text(&mut app, "/quit");
        assert_eq!(app.on_key(key(KeyCode::Enter)), Some(Action::Quit));
    }

    #[test]
    fn quick_replies_appear_only_after_an_answer_and_alt_digits_send_them() {
        let mut app = app_with(vec![Message::User { text: "сделай".into() }, Message::Assistant { text: "готово".into(), calls: vec![] }]);
        assert!(app.quick_visible());
        assert_eq!(app.on_key(mods(KeyCode::Char('2'), KeyModifiers::ALT)), Some(Action::Submit("проверь тестами".into())));
        type_text(&mut app, "x");
        assert!(!app.quick_visible());
        assert_eq!(app.on_key(mods(KeyCode::Char('1'), KeyModifiers::ALT)), None);
    }

    #[test]
    fn alt_arrows_cycle_tabs() {
        let mut app = app_with(vec![]);
        app.tabs.push(Tab::new(session(vec![])));
        app.on_key(mods(KeyCode::Right, KeyModifiers::ALT));
        assert_eq!(app.active, 1);
        app.on_key(mods(KeyCode::Right, KeyModifiers::ALT));
        assert_eq!(app.active, 0);
        app.on_key(mods(KeyCode::Left, KeyModifiers::ALT));
        assert_eq!(app.active, 1);
    }

    #[test]
    fn wrapping_breaks_at_spaces_handles_wide_text_and_never_loops_on_a_long_word() {
        assert_eq!(wrap("one two three", 7), ["one two", "three"]);
        assert_eq!(wrap("абвгд", 2), ["аб", "вг", "д"]);
        assert_eq!(wrap("日本語", 4), ["日本", "語"]);
        assert_eq!(wrap("a\n\nb", 5), ["a", "", "b"]);
        assert!(wrap("supercalifragilistic", 5).iter().all(|part| part.chars().count() <= 5));
    }

    #[test]
    fn history_becomes_rows_and_a_result_joins_its_call_on_one_row() {
        let call = ToolCall { id: "c1".into(), name: "list_dir".into(), input: "{}".into() };
        let rows = rows_from(&[
            Message::User { text: "покажи".into() },
            Message::Assistant { text: "смотрю".into(), calls: vec![call] },
            Message::Tool { id: "c1".into(), output: "a.txt\nb.txt".into() },
        ]);
        assert_eq!(rows.len(), 3);
        assert!(matches!(&rows[2], Row::Tool { result: Some(result), .. } if result == "a.txt …"));
    }

    #[test]
    fn streaming_text_extends_one_row_and_a_wait_row_is_replaced_by_output() {
        let mut tab = Tab::new(session(vec![]));
        apply(&mut tab, Ok(Event::Wait { ms: 5000, reason: "лимит".into() }));
        apply(&mut tab, Ok(Event::Wait { ms: 4000, reason: "лимит".into() }));
        assert_eq!(tab.rows.len(), 1);
        apply(&mut tab, Ok(Event::Text("при".into())));
        apply(&mut tab, Ok(Event::Text("вет".into())));
        assert_eq!(tab.rows, [Row::Assistant("привет".into())]);
        apply(&mut tab, Err(TransportError::new("сбой", orchestra_kernel::ErrorKind::Fatal)));
        assert!(matches!(tab.rows.last(), Some(Row::Error(text)) if text == "сбой"));
    }

    #[test]
    fn the_screen_has_the_frame_tabs_dither_input_and_no_fills_at_all() {
        let mut app = app_with(vec![Message::User { text: "привет".into() }, Message::Assistant { text: "здравствуйте".into(), calls: vec![] }]);
        app.tabs.push(Tab::new(session(vec![])));
        let (rows, no_fill) = render(&app, 100, 14);
        let screen = rows.join("\n");
        assert!(no_fill, "the interface must be outline only");
        assert!(screen.contains("orchestra") && screen.contains("░▒▓"));
        assert!(screen.contains("[1 привет]") && screen.contains("2 новая"));
        assert!(screen.contains("› привет") && screen.contains("здравствуйте"));
        assert!(screen.contains("› ") && screen.contains("Enter отправить"));
        assert!(rows[0].starts_with('╭') && rows[13].starts_with('╰'));
    }

    #[test]
    fn working_tabs_commands_and_quick_replies_show_up_where_expected() {
        let mut app = app_with(vec![Message::User { text: "a".into() }, Message::Assistant { text: "b".into(), calls: vec![] }]);
        let (idle, _) = render(&app, 100, 12);
        assert!(idle.join("\n").contains("[1 продолжай]") && idle.join("\n").contains("готов"));

        app.tabs[0].busy = true;
        let (busy, _) = render(&app, 100, 12);
        assert!(busy.join("\n").contains("работает") && busy.join("\n").contains("Esc прервать"));

        app.tabs[0].busy = false;
        type_text(&mut app, "/me");
        let (typing, _) = render(&app, 100, 12);
        assert!(typing.join("\n").contains("/memory"));
    }

    #[test]
    fn the_window_follows_the_newest_line_and_page_up_reveals_older_ones() {
        let messages: Vec<Message> = (0..40).map(|n| Message::User { text: format!("реплика{n:02}") }).collect();
        let mut app = app_with(messages);
        let (bottom, _) = render(&app, 60, 12);
        eprintln!("{}", bottom.join("
"));
        assert!(bottom.join("\n").contains("› реплика39") && !bottom.join("\n").contains("› реплика00"));
        app.on_key(key(KeyCode::PageUp));
        let (up, _) = render(&app, 60, 12);
        assert!(up.join("\n").contains("↓ ещё 8"));
        assert!(!up.join("\n").contains("› реплика39"));
    }

    #[test]
    fn a_narrow_terminal_does_not_panic() {
        let app = app_with(vec![Message::User { text: "длинное сообщение которое не помещается".into() }]);
        for width in [12, 20, 30] {
            render(&app, width, 8);
        }
    }
}
