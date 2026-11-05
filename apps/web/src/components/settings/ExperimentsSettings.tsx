import { useAtomValue } from "@effect/atom-react";
import {
  experimentKindWords,
  isDiscardedDraft,
  isRolloverTrial,
  miniResultWords,
  resultsVerdict,
  trialDraftFromExperiment,
  trialDraftIssues,
  trialGroupOf,
  trialProgressWords,
  trialStateWord,
} from "@t3tools/client-runtime/experiments";
import type { EnvironmentId, Experiment } from "@t3tools/contracts";
import { useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { TrialEditor } from "./ExperimentTrialEditor";
import { TrialResults } from "./ExperimentTrialResults";
import {
  IssueLine,
  TrialActionButtons,
  TrialErrorBox,
  TrialNote,
  TrialRow,
  useTrialActions,
  useTrialEnvironment,
  VariantName,
} from "./ExperimentParts";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type View =
  | { readonly kind: "list" }
  | {
      readonly kind: "edit";
      readonly environmentId: EnvironmentId;
      readonly editing: Experiment | null;
    }
  | {
      readonly kind: "results";
      readonly environmentId: EnvironmentId;
      readonly experimentId: string;
    };

const FINISHED_SHOWN = 10;

export function ExperimentsSettings() {
  const { environments } = useSettingsScope();
  const [view, setView] = useState<View>({ kind: "list" });
  const show = (next: View) => {
    setView(next);
    document.querySelector("[data-settings-page-scroll]")?.scrollTo(0, 0);
  };
  const toList = () => show({ kind: "list" });
  return (
    <SettingsPageContainer>
      {environments.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Connect an environment to manage trials.
        </p>
      ) : view.kind === "edit" ? (
        <TrialEditor
          key={view.editing?.id ?? "new"}
          environmentId={view.environmentId}
          editing={view.editing}
          onDone={toList}
          onOpenTrial={(experimentId) =>
            show({ kind: "results", environmentId: view.environmentId, experimentId })
          }
        />
      ) : view.kind === "results" ? (
        <TrialResults
          key={view.experimentId}
          environmentId={view.environmentId}
          experimentId={view.experimentId}
          onBack={toList}
          onEdit={(editing) => show({ kind: "edit", environmentId: view.environmentId, editing })}
        />
      ) : (
        environments.map((environment, index) => (
          <EnvironmentTrials
            key={environment.environmentId}
            environment={environment}
            title={environments.length > 1 ? `Experiments · ${environment.label}` : "Experiments"}
            showIntro={index === 0}
            onShow={show}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentTrials({
  environment,
  title,
  showIntro,
  onShow,
}: {
  environment: EnvironmentPresentation;
  title: string;
  showIntro: boolean;
  onShow: (view: View) => void;
}) {
  const environmentId = environment.environmentId;
  const connected = environment.connection.phase === "connected";
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.experimentsList({ environmentId, input: {} }) : null,
  );
  const canCreate = useAtomValue(serverEnvironment.experimentsCreate.permissionAtom(environmentId));
  const [allFinished, setAllFinished] = useState(false);
  const trials = (query.data ?? []).filter((trial) => !isDiscardedDraft(trial));
  const running = trials
    .filter((trial) => trialGroupOf(trial) === "running")
    .toSorted((left, right) => left.status.localeCompare(right.status) * -1);
  const drafts = trials.filter((trial) => trialGroupOf(trial) === "drafts");
  const finished = trials
    .filter((trial) => trialGroupOf(trial) === "finished")
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const shownFinished = allFinished ? finished : finished.slice(0, FINISHED_SHOWN);
  const row = (trial: Experiment) => (
    <TrialListRow
      key={trial.id}
      environmentId={environmentId}
      experiment={trial}
      others={trials.filter((other) => other.id !== trial.id)}
      onChanged={query.refresh}
      onShow={onShow}
    />
  );
  return (
    <>
      <div className="flex flex-col gap-2.5 px-3 sm:px-4">
        <div className="flex min-h-7 items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="ghost-muted" disabled={!connected} onClick={query.refresh}>
              Reload
            </Button>
            <Button
              size="xs"
              disabled={!connected || !canCreate}
              onClick={() => onShow({ kind: "edit", environmentId, editing: null })}
            >
              New trial
            </Button>
          </div>
        </div>
        {showIntro ? (
          <p className="text-sm text-muted-foreground">
            Try different agent setups against each other on real work, and see which does better.
            New work gets one setup at random. Nothing changes in Delegation unless you choose to.
          </p>
        ) : null}
        {!connected ? (
          <TrialNote>Reconnect this environment to view its experiments.</TrialNote>
        ) : null}
        {query.isPending && query.data === null ? (
          <TrialNote>Loading experiments…</TrialNote>
        ) : null}
      </div>
      {query.error ? (
        <Alert variant="error">
          <AlertDescription>{query.error}</AlertDescription>
        </Alert>
      ) : null}
      {query.data === null ? null : (
        <>
          <TrialGroup title="Running" empty="Nothing is running.">
            {running.map(row)}
          </TrialGroup>
          <TrialGroup title="Drafts" empty="No drafts.">
            {drafts.map(row)}
          </TrialGroup>
          <TrialGroup title="Finished" empty="Nothing has finished yet.">
            {shownFinished.map(row)}
            {finished.length > shownFinished.length ? (
              <TrialRow>
                <Button size="xs" variant="ghost-muted" onClick={() => setAllFinished(true)}>
                  Show {finished.length - shownFinished.length} more
                </Button>
              </TrialRow>
            ) : null}
          </TrialGroup>
        </>
      )}
    </>
  );
}

function TrialGroup({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : children;
  const hasItems = Array.isArray(items) ? items.length > 0 : Boolean(items);
  return (
    <SettingsSection title={title}>
      {hasItems ? (
        children
      ) : (
        <TrialRow>
          <TrialNote>{empty}</TrialNote>
        </TrialRow>
      )}
    </SettingsSection>
  );
}

function TrialListRow({
  environmentId,
  experiment,
  others,
  onChanged,
  onShow,
}: {
  environmentId: EnvironmentId;
  experiment: Experiment;
  others: ReadonlyArray<Experiment>;
  onChanged: () => void;
  onShow: (view: View) => void;
}) {
  const setup = useTrialEnvironment(environmentId);
  const actions = useTrialActions(environmentId, experiment, onChanged);
  const isDraft = experiment.status === "draft" && !isRolloverTrial(experiment);
  const results = useEnvironmentQuery(
    isDraft
      ? null
      : serverEnvironment.experimentsResults({
          environmentId,
          input: { experimentId: experiment.id, limit: 1 },
        }),
  );
  const openResults = () => onShow({ kind: "results", environmentId, experimentId: experiment.id });
  const edit = () => onShow({ kind: "edit", environmentId, editing: experiment });
  const issues = isDraft
    ? trialDraftIssues(trialDraftFromExperiment(experiment), setup.contextFor(others))
    : null;
  const lines = issues === null ? [] : [...issues.variants.flat(), ...issues.work, ...issues.stop];
  const enrolled =
    results.data === null
      ? null
      : results.data.variants.reduce((sum, variant) => sum + variant.enrolled, 0);
  const verdict = results.data === null ? null : resultsVerdict(results.data);
  const showState = experiment.status === "paused" || isRolloverTrial(experiment);
  return (
    <TrialRow>
      <article className="contents">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 flex-[1_1_15rem] flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              className="text-left text-sm font-medium hover:underline"
              onClick={isDraft ? edit : openResults}
            >
              {experiment.title}
            </button>
            {showState ? (
              <Badge variant="outline" size="sm">
                {trialStateWord(experiment)}
              </Badge>
            ) : null}
          </div>
          <TrialActionButtons
            experiment={experiment}
            actions={actions}
            blocked={issues?.blocked ?? false}
            onResults={openResults}
            onEdit={edit}
          />
        </div>
        <TrialNote className="line-clamp-2">{experiment.question}</TrialNote>
        <TrialNote>
          {experimentKindWords(experiment)} ·{" "}
          {experiment.variants.map((variant) => variant.label).join(" or ")} ·{" "}
          {trialProgressWords(experiment, enrolled, setup.now)}
        </TrialNote>
        {results.data === null ? null : (
          <ul className="flex flex-col text-xs tabular-nums">
            {results.data.variants.map((variant, index) => (
              <li
                key={variant.variantId}
                className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] gap-x-2 border-t border-border/50 py-0.5"
              >
                <span>
                  <VariantName label={variant.label} index={index} />
                </span>
                <span className="text-muted-foreground">
                  {miniResultWords(experiment, variant)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {verdict?.tooFew ? (
          <TrialNote>
            {enrolled === 0 ? "Nothing enrolled yet" : "Too few results to conclude"}
          </TrialNote>
        ) : null}
        {results.error ? <TrialNote>Results can't be read right now.</TrialNote> : null}
        {lines.map((issue) => (
          <IssueLine
            key={issue.text}
            issue={issue}
            onOpenTrial={(experimentId) => onShow({ kind: "results", environmentId, experimentId })}
          />
        ))}
        <TrialErrorBox failure={actions.failure} onDismiss={actions.dismissFailure} />
      </article>
    </TrialRow>
  );
}
