# Per-project AI work control

Each project stores optional `workEnabled`. New projects are ON. Listing legacy projects persists ON; reads treat absent flags as ON. The existing global safety switch is retained and labelled "All projects". It overrides project switches without changing their stored choices.

The project switch closes admission durably before stopping its active sessions with the existing pause outcome. Work, queued inbox items and suspended execution claims remain. It resolves explicit ownership, stable main ID and parent lineage before directory fallback, so projects sharing a folder stay separate. Group chats stay independent. Session wake/resume/steer continuation and restart admission all honor the same guard. Only this project's background shell jobs are cancelled, retaining outcomes rather than replaying OS commands.

Orchestra dispatch, recovery, activation and triggers skip paused projects. The Autoloop journal keeps factual outcomes, but paused project claims cannot be handed out and its leases do not expire during pause; unpaused projects still advance. Timer calculation excludes paused runs, avoiding a hot loop. ON refreshes this project's owned leases, rearms the clock and resumes its parked work. It never changes user-authored rulebooks or invents completion.

Verification uses a real execution coordinator and database with two explicit projects in the same directory, a child session, preserved inbox work, and an unrelated running session. Separate real Autoloop tests cover lease/claim isolation, Job tests cover shell isolation, Orchestra tests cover persistence/migration, and ServerFetch tests cover PATCH/read state. TUI component renders at 48/80 show one OFF and one ON beneath the master switch. Native Windows runtime was not exercised.
