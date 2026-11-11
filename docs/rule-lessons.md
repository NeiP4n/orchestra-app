# Rule lessons

Rule enforcement stays unchanged. After repeated refused calls or judged rule violations, the next request can include a short reminder to check that current rule before acting. No model call is used to create a lesson.

- On by default. Set `experimental.rule_lessons` to `false` in Orchestra config to stop both learning and prompt injection on the next context refresh. Set it back to `true` to resume. Existing saved reminders stay available while off; this is not a permissions switch.
- At most three fingerprints per project, two observations needed for each reminder. Counts stop at two. The in-process session registry has a 500-session cap.
- Only a SHA256 rule identity and a count are saved. Tool arguments, paths, page contents, transcripts and judge explanations are not copied into lesson storage. The original rule is read from the current successfully loaded rulebook when a reminder is shown.
- Only rules that currently apply are eligible. Changed or removed rules produce no reminder, even if an old fingerprint remains saved. Project scope comes from the existing verified rule scope lookup. Another project's reminders are not used. Deleting the project deletes its reminder storage.
- Lessons do not edit rules, replace the rulebook, change scope priority, grant access, bypass a refusal or change completion gates. A lesson-storage error drops only reminders, not the loaded rules or enforcement. There is no automatic promotion of page text or model explanations into instructions.

These reminders add bounded context; they do not prove fewer violations or lower billed usage. No real-model token savings are claimed without a measured run.
