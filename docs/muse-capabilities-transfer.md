# What Muse can do that Orchestra should steal

Analysis of Muse (Meta's personal agent) against Orchestra, done 2026-11-02.
Goal: not a feature dump — only capabilities that remove work from the
user, in the spirit of "the user only writes the task". Orchestra already
has long-term memory blocks (human/project/archive), an idea bank, teams,
roles, templates, federation, and subagents — those are NOT listed here.

## 1. Goals and tracked commitments (highest value)

Muse keeps durable goals and tracked items (reservations, deliveries,
reminders, ongoing projects) separate from chat sessions, with progress
and a finish condition. A session ends; a goal does not.
Orchestra sessions and idea bank do not cover this: a multi-day task
("ship the release", "wait for the reviewer's reply") has no home once
its session scrolls away.
Proposal: a goals store + a Goals view, fed by sessions, with "done"
only when the outcome is verified, not when one step succeeds.

## 2. Scheduled background work (reminders and watches)

Muse runs crons and event hooks: "check every morning", "tell me when
the reply arrives", "remind me before the deadline". Orchestra jobs
serve subagents, but the user cannot ask Orchestra to wake up later.
Proposal: user-facing schedules attached to a goal or a session, each
with an owner, a stop condition, and a delivery chat. A schedule is not
proof of delivery — every run must report success or failure plainly.

## 3. Proactive updates, not just answers

Muse surfaces new information unprompted when it matters (a reply
arrived, a price changed, a task finished) and stays silent for routine
no-ops. Orchestra today only answers. Combined with (2), this turns
Orchestra from a chatbot into an assistant that watches things for you.
Proposal: a delivery rule — notify only when information is meaningfully
new and worth interrupting for, with user-editable proactive
preferences (topics, timing, presentation).

## 4. Artifacts that outlive the chat

Muse builds documents, pages, decks, and spreadsheets the user can open
later, with a stable home and an edit path — not a message that scrolls
away. Orchestra's session timeline is the only home for output today.
Proposal: an artifacts store per goal/project, built by agents through
declared actions, delivered with a link in the same message that says
it is ready.

## 5. A people map

Muse keeps a relationship map (people, groups, who matters, what was
decided with whom) separate from chat memory. Orchestra's human memory
block holds facts, but not who people are to the user or what the
current dynamics are. For a dream team that talks to real people, this
is the missing context.
Proposal: people/group records, read before answering about someone,
updated only from the user's own words, never guessed.

## 6. Browser takeover and deep research

Muse's browser lets the user take over to pass a CAPTCHA, a sign-in,
or a payment, then hands control back and the task resumes where it
left off. Separately, an isolated signed-out researcher returns sourced
findings. Orchestra's browser-adjacent work (plugin-browser) does not
offer either pattern as a first-class flow.
Proposal: takeover as a defined state (prepare → user acts → resume),
and a research mode that never signs in and cites sources.

## 7. Voice notes and file sharing (nice to have, not first)

Muse sends voice notes, narrates text, and shares files through links
that expire. These are cheap wins once (4) exists, and should come
after 1–5, not before.

## What NOT to copy

- Wallet and payment coordination: powerful, but it brings approvals,
  refunds, and fraud surface that Orchestra does not need for an
  autonomous workspace.
- Side-chat workers with discretion rules: valuable for messaging, but
  it is a product of its own; do not bolt it on before 1–5 land.

## Suggested order

1. Goals/tracking, 2. schedules, 3. proactive delivery rules,
4. artifacts, 5. people map — then voice/file sharing.
