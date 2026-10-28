import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { checksum } from "../packages/util/src/encode.ts";

const dbPath = "C:/Users/Isako/.local/share/orchestra/orchestra-local.db";
if (!fs.existsSync(dbPath)) {
  console.error("Database not found at:", dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

// 1. Directories for the 3 Masters
const masters = [
  {
    key: "strategy",
    name: "Стратегия и Архитектура",
    directory: "C:/Users/Isako/dev/masters/strategy",
    template: "strategic-planning",
    callsign: "Atlas",
  },
  {
    key: "engineering",
    name: "Инженерия и Разработка",
    directory: "C:/Users/Isako/dev/masters/engineering",
    template: "pro-engineers",
    callsign: "Borei",
  },
  {
    key: "audit",
    name: "Безопасность и Ресерчинг",
    directory: "C:/Users/Isako/dev/masters/audit",
    template: "deep-audit",
    callsign: "Cinder",
  },
];

for (const m of masters) {
  if (!fs.existsSync(m.directory)) {
    fs.mkdirSync(m.directory, { recursive: true });
    fs.writeFileSync(path.join(m.directory, "README.md"), `# ${m.name}\n\nКоманда: ${m.template}\n`, "utf8");
  }
}

// 2. Resolve or create Project records
const groupName = "Совет Мастеров";
const now = Date.now();

const projects: Array<{ id: string; name: string; directory: string; main: string; template: string }> = [];

for (const m of masters) {
  // Check if project exists in kv
  const kvRows = db.query("SELECT key, value FROM kv WHERE key LIKE 'orchestra/project/%'").all() as { key: string; value: string }[];
  let existingProject: any = null;
  for (const row of kvRows) {
    try {
      const parsed = JSON.parse(row.value);
      if (parsed.directory === m.directory) {
        existingProject = parsed;
        break;
      }
    } catch {}
  }

  const projId = existingProject?.id ?? `prj_master_${m.key}`;
  const mainSessionId = existingProject?.main ?? `ses_main_${m.key}_${checksum(m.directory)}`;

  // Ensure project in project table (SQLite)
  db.run(
    `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, time_active, sandboxes)
     VALUES (?, ?, 'git', ?, ?, ?, ?, '[]')
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, time_updated = excluded.time_updated`,
    [projId, m.directory, m.name, now, now, now]
  );

  // Ensure main session in session_v2
  db.run(
    `INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, time_created, time_updated)
     VALUES (?, ?, ?, ?, '', ?, '2.0.0', 'orchestrator', ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, time_updated = excluded.time_updated`,
    [mainSessionId, projId, `master-${m.key}`, m.directory, `${m.name} · Оркестратор`, now, now]
  );

  // Persist project in kv
  const projRecord = {
    id: projId,
    name: m.name,
    directory: m.directory,
    main: mainSessionId,
    created: now,
  };
  db.run("INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)", [
    `orchestra/project/${projId}`,
    JSON.stringify(projRecord),
    now,
    now,
  ]);

  // Persist project template in kv
  db.run("INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)", [
    `orchestra/project-template/${projId}`,
    JSON.stringify(m.template),
    now,
    now,
  ]);

  // Set owner in kv
  db.run("INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)", [
    `orchestra/owner/${mainSessionId}`,
    JSON.stringify(projId),
    now,
    now,
  ]);

  projects.push({ id: projId, name: m.name, directory: m.directory, main: mainSessionId, template: m.template });
}

console.log("Registered 3 master projects:", projects.map((p) => `${p.name} (${p.id})`));

// 3. Create Society Supervisor session
const slug = groupName.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
const groupDir = path.join("C:/Users/Isako/.local/share/orchestra/group", `${slug}-${checksum(groupName) ?? "0"}`);
fs.mkdirSync(groupDir, { recursive: true });

const supervisorSessionId = `ses_society_${checksum(groupName) ?? "council"}`;
const leaderId = projects[0]!.id;

const supervisorMetadata = {
  "orchestra:group-supervisor": {
    groupName,
    leader: leaderId,
    mode: "council",
  },
};

db.run(
  `INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, metadata, time_created, time_updated)
   VALUES (?, ?, 'society-council', ?, '', 'Общество', '2.0.0', 'orchestrator', ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET title = 'Общество', metadata = excluded.metadata, time_updated = excluded.time_updated`,
  [supervisorSessionId, leaderId, groupDir, JSON.stringify(supervisorMetadata), now, now]
);

// 4. Register Group in KV
const groupRecord = {
  name: groupName,
  projects: projects.map((p) => p.id),
  mode: "council",
  supervisor: supervisorSessionId,
};

db.run("INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)", [
  `federation/group/${groupName}`,
  JSON.stringify(groupRecord),
  now,
  now,
]);

// 5. Register Mutual Federation Policies (Full peer consensus)
for (const p of projects) {
  const peers = projects.filter((other) => other.id !== p.id);
  const policy = {
    project: p.id,
    visibility: "read",
    grants: peers.map((peer) => ({
      peer: peer.id,
      allow: ["question", "request", "contract"],
      autoAnswer: true,
    })),
    maxOpen: 10,
  };
  db.run("INSERT OR REPLACE INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)", [
    `federation/policy/${p.id}`,
    JSON.stringify(policy),
    now,
    now,
  ]);
}

console.log(`\n======================================================`);
console.log(` Успешно создано Общество (Council): "${groupName}"`);
console.log(`======================================================`);
console.log(`Сессия Общества (Supervisor): ${supervisorSessionId}`);
console.log(`Директория Совета: ${groupDir}`);
console.log(`\nУчастники (Мастера):`);
for (const p of projects) {
  console.log(`- ${p.name} [${p.id}] -> Шаблон команды: ${p.template}`);
}
console.log(`\nВсе мастера взаимно связаны (link policies):`);
console.log(`Разрешён обмен тикетами 'question', 'request', 'contract' и режим consult_all.`);
