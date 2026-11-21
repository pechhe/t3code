import {
  ChampionCharter,
  ChampionConfig,
  ChampionFinding,
  ChampionLearningContent,
  ChampionLearningContributor,
  ChampionLearningRevision,
  ChampionLifecycle,
  ChampionMetric,
  ChampionSample,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ChampionFolderDefinition {
  id: ChampionConfig["id"];
  name: ChampionConfig["name"];
  purpose: ChampionConfig["purpose"];
  repository: string;
  runner: { environmentId: string; label: string };
  lifecycle: ChampionLifecycle;
  schedule: ChampionConfig["schedule"];
  charter: ChampionConfig["charter"];
  models?: ChampionConfig["models"];
  journeys?: ChampionConfig["journeys"];
  repairsVia?: ChampionConfig["repairsVia"];
  whenInTarget?: "rest" | "work";
}

export type ChampionFolderLearning = typeof ChampionLearningContent.Type & {
  learningId: string;
  recordedAt: string;
  reason: string;
  contribution?: ChampionLearningContributor;
};

export type ChampionFolderFinding = Pick<
  ChampionFinding,
  | "id"
  | "metricId"
  | "seriesId"
  | "title"
  | "evidence"
  | "status"
  | "diagnosis"
  | "undiagnosed"
  | "baselineValue"
  | "baselineMetric"
  | "workId"
  | "attemptId"
  | "revision"
  | "specUrl"
  | "updatedAt"
> & { carriedOver?: { from: string; at: string } };

export interface ChampionFolderReading {
  metricId: string;
  version: number;
  unit: string;
  status: ChampionSample["status"];
  value: number | null;
  observedAt: string;
  collectedAt: string;
  source: string;
  evidence: string;
  revision: string | null;
  provenance: "agent-reported" | "server-collected";
}

export interface ChampionFolder {
  definition: ChampionFolderDefinition;
  metrics: ReadonlyArray<ChampionMetric>;
  learnings: ReadonlyArray<ChampionFolderLearning>;
  findings: ReadonlyArray<ChampionFolderFinding>;
  readings: ReadonlyArray<ChampionFolderReading>;
}

export interface FolderFileContent {
  path: string;
  content: string;
}

export interface ParsedChampionFolder {
  definition: ChampionFolderDefinition | null;
  metrics: ReadonlyArray<ChampionMetric> | null;
  learnings: ReadonlyArray<ChampionFolderLearning>;
  findings: ReadonlyArray<ChampionFolderFinding>;
  readings: ReadonlyArray<ChampionFolderReading>;
  problems: ReadonlyArray<string>;
}

const { conclusion: _conclusion, ...learningContentFields } = ChampionLearningContent.fields;

const DefinitionFrontmatter = Schema.Struct({
  id: ChampionConfig.fields.id,
  name: ChampionConfig.fields.name,
  purpose: ChampionConfig.fields.purpose,
  repository: Schema.String,
  runner: Schema.Struct({ environmentId: Schema.String, label: Schema.String }),
  lifecycle: ChampionLifecycle,
  schedule: ChampionConfig.fields.schedule,
  limits: Schema.Struct({
    maxConcurrentRepairs: ChampionCharter.fields.maxConcurrentRepairs,
    maxRepairsPerDay: ChampionCharter.fields.maxRepairsPerDay,
  }),
  models: ChampionConfig.fields.models,
  journeys: ChampionConfig.fields.journeys,
  repairsVia: ChampionConfig.fields.repairsVia,
  whenInTarget: Schema.optional(Schema.Literals(["rest", "work"])),
});

const LearningFrontmatter = Schema.Struct({
  learningId: ChampionLearningRevision.fields.learningId,
  recordedAt: ChampionLearningRevision.fields.recordedAt,
  reason: ChampionLearningRevision.fields.reason,
  contribution: Schema.optional(ChampionLearningContributor),
  ...learningContentFields,
});

const FindingFrontmatter = Schema.Struct({
  id: ChampionFinding.fields.id,
  metricId: ChampionFinding.fields.metricId,
  seriesId: ChampionFinding.fields.seriesId,
  title: ChampionFinding.fields.title,
  status: ChampionFinding.fields.status,
  diagnosis: ChampionFinding.fields.diagnosis,
  undiagnosed: ChampionFinding.fields.undiagnosed,
  baselineValue: ChampionFinding.fields.baselineValue,
  baselineMetric: ChampionFinding.fields.baselineMetric,
  workId: ChampionFinding.fields.workId,
  attemptId: ChampionFinding.fields.attemptId,
  revision: ChampionFinding.fields.revision,
  specUrl: ChampionFinding.fields.specUrl,
  updatedAt: ChampionFinding.fields.updatedAt,
  carriedOver: Schema.optional(Schema.Struct({ from: Schema.String, at: Schema.String })),
});

const ReadingLine = Schema.Struct({
  metricId: ChampionSample.fields.metricId,
  version: ChampionSample.fields.version,
  unit: ChampionSample.fields.unit,
  status: ChampionSample.fields.status,
  value: ChampionSample.fields.value,
  observedAt: ChampionSample.fields.observedAt,
  collectedAt: ChampionSample.fields.collectedAt,
  source: ChampionSample.fields.source,
  evidence: ChampionSample.fields.evidence,
  revision: ChampionSample.fields.revision,
  provenance: ChampionSample.fields.provenance,
});

const decodeDefinition = Schema.decodeUnknownSync(DefinitionFrontmatter);
const decodeCharter = Schema.decodeUnknownSync(ChampionCharter);
const decodeMetrics = Schema.decodeUnknownSync(Schema.Array(ChampionMetric));
const decodeLearning = Schema.decodeUnknownSync(LearningFrontmatter);
const decodeFinding = Schema.decodeUnknownSync(FindingFrontmatter);
const decodeReading = Schema.decodeUnknownSync(ReadingLine);
const decodeBody = Schema.decodeUnknownSync(Schema.String.check(Schema.isMinLength(1)));

const LEARNING_KEYS = [
  "learningId",
  "recordedAt",
  "reason",
  "contribution",
  "topic",
  "plainSummary",
  "question",
  "attempts",
  "evidence",
  "components",
  "environment",
  "applicability",
  "tradeoffs",
  "reviewAt",
  "reviewConditions",
  "versionConditions",
] as const;

const FINDING_KEYS = [
  "id",
  "metricId",
  "seriesId",
  "title",
  "status",
  "diagnosis",
  "undiagnosed",
  "baselineValue",
  "baselineMetric",
  "workId",
  "attemptId",
  "revision",
  "specUrl",
  "updatedAt",
  "carriedOver",
] as const;

const READING_KEYS = [
  "metricId",
  "version",
  "unit",
  "status",
  "value",
  "observedAt",
  "collectedAt",
  "source",
  "evidence",
  "revision",
  "provenance",
] as const;

const pick = (source: object, keys: ReadonlyArray<string>) => {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n([\s\S]*))?$/;

const renderDocument = (frontmatter: Record<string, unknown>, body: string) =>
  `---\n${stringifyYaml(frontmatter, { lineWidth: 0 })}---\n\n${body.trim()}\n`;

const splitDocument = (content: string): { frontmatter: unknown; body: string } => {
  const match = FRONTMATTER.exec(content.trim());
  if (!match) throw new Error("missing YAML frontmatter between --- lines");
  const frontmatter: unknown = parseYaml(match[1] ?? "");
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("frontmatter is not a mapping");
  }
  return { frontmatter, body: (match[2] ?? "").trim() };
};

const encodeName = (id: string) =>
  encodeURIComponent(id).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ").trim();

export const championFolderPath = (group: string, id: string) => `champions/${group}/${id}`;

export const renderChampionFolder = (folder: ChampionFolder): ReadonlyArray<FolderFileContent> => {
  const { definition } = folder;
  const files: FolderFileContent[] = [
    {
      path: "champion.md",
      content: renderDocument(
        pick(
          {
            id: definition.id,
            name: definition.name,
            purpose: definition.purpose,
            repository: definition.repository,
            runner: {
              environmentId: definition.runner.environmentId,
              label: definition.runner.label,
            },
            lifecycle: definition.lifecycle,
            schedule: definition.schedule,
            limits: {
              maxConcurrentRepairs: definition.charter.maxConcurrentRepairs,
              maxRepairsPerDay: definition.charter.maxRepairsPerDay,
            },
            models: definition.models,
            journeys: definition.journeys,
            repairsVia: definition.repairsVia,
            whenInTarget: definition.whenInTarget,
          },
          [
            "id",
            "name",
            "purpose",
            "repository",
            "runner",
            "lifecycle",
            "schedule",
            "limits",
            "models",
            "journeys",
            "repairsVia",
            "whenInTarget",
          ],
        ),
        definition.charter.instructions,
      ),
    },
    { path: "metrics.json", content: `${JSON.stringify(folder.metrics, null, 2)}\n` },
  ];

  for (const learning of [...folder.learnings].toSorted((a, b) =>
    compare(a.learningId, b.learningId),
  )) {
    files.push({
      path: `learnings/${encodeName(learning.learningId)}.md`,
      content: renderDocument(pick(learning, LEARNING_KEYS), learning.conclusion),
    });
  }

  for (const finding of [...folder.findings].toSorted((a, b) => compare(a.id, b.id))) {
    files.push({
      path: `findings/${encodeName(finding.id)}.md`,
      content: renderDocument(pick(finding, FINDING_KEYS), finding.evidence),
    });
  }

  const byMetric = new Map<string, Array<ChampionFolderReading>>();
  for (const reading of folder.readings) {
    const list = byMetric.get(reading.metricId);
    if (list) list.push(reading);
    else byMetric.set(reading.metricId, [reading]);
  }
  for (const metricId of [...byMetric.keys()].toSorted(compare)) {
    const lines = readingLines(byMetric.get(metricId) ?? []);
    files.push({
      path: `readings/${encodeName(metricId)}.jsonl`,
      content: lines.map((line) => `${JSON.stringify(pick(line, READING_KEYS))}\n`).join(""),
    });
  }
  return files;
};

const readingLines = (readings: ReadonlyArray<ChampionFolderReading>) => {
  const seen = new Set<string>();
  const unique: ChampionFolderReading[] = [];
  for (const reading of readings) {
    const key = JSON.stringify([
      reading.metricId,
      reading.observedAt,
      reading.collectedAt,
      reading.value,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reading);
  }
  return unique.toSorted(
    (a, b) => compare(a.observedAt, b.observedAt) || compare(a.collectedAt, b.collectedAt),
  );
};

export const parseChampionFolder = (
  files: ReadonlyArray<FolderFileContent>,
): ParsedChampionFolder => {
  const problems: string[] = [];
  let definition: ChampionFolderDefinition | null = null;
  let metrics: ReadonlyArray<ChampionMetric> | null = null;
  const learnings: ChampionFolderLearning[] = [];
  const findings: ChampionFolderFinding[] = [];
  const readings: ChampionFolderReading[] = [];
  let sawDefinition = false;
  let sawMetrics = false;

  const attempt = (path: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      problems.push(`${path}: ${reason(error)}`);
    }
  };

  for (const file of [...files].toSorted((a, b) => compare(a.path, b.path))) {
    const { path, content } = file;
    if (path === "champion.md") {
      sawDefinition = true;
      attempt(path, () => {
        const { frontmatter, body } = splitDocument(content);
        const front = decodeDefinition(frontmatter);
        const charter = decodeCharter({
          ...front.limits,
          ...(body.length > 0 ? { instructions: decodeBody(body) } : {}),
        });
        const { limits: _limits, ...rest } = front;
        definition = { ...rest, charter } as ChampionFolderDefinition;
      });
    } else if (path === "metrics.json") {
      sawMetrics = true;
      attempt(path, () => {
        metrics = decodeMetrics(JSON.parse(content));
      });
    } else {
      const learning = /^learnings\/([^/]+)\.md$/.exec(path);
      const finding = /^findings\/([^/]+)\.md$/.exec(path);
      const reading = /^readings\/([^/]+)\.jsonl$/.exec(path);
      if (learning) {
        attempt(path, () => {
          const { frontmatter, body } = splitDocument(content);
          const front = decodeLearning(frontmatter);
          const name = safeDecodeName(learning[1] ?? "");
          if (front.learningId !== name) {
            throw new Error(`learningId "${front.learningId}" does not match the file name`);
          }
          learnings.push({ ...front, conclusion: decodeBody(body) } as ChampionFolderLearning);
        });
      } else if (finding) {
        attempt(path, () => {
          const { frontmatter, body } = splitDocument(content);
          const front = decodeFinding(frontmatter);
          findings.push({ ...front, evidence: decodeBody(body) } as ChampionFolderFinding);
        });
      } else if (reading) {
        attempt(path, () => {
          const parsed: ChampionFolderReading[] = [];
          content.split(/\r?\n/).forEach((line, index) => {
            if (line.trim() === "") return;
            try {
              parsed.push(decodeReading(JSON.parse(line)));
            } catch (error) {
              throw new Error(`line ${index + 1}: ${reason(error)}`, { cause: error });
            }
          });
          readings.push(...parsed);
        });
      }
    }
  }

  if (!sawDefinition) problems.push("champion.md: missing");
  if (!sawMetrics) problems.push("metrics.json: missing");

  return {
    definition,
    metrics,
    learnings,
    findings,
    readings: readingLines(readings),
    problems,
  };
};

const safeDecodeName = (name: string) => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};
