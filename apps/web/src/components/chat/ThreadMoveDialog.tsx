import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { threadHandoffEnvironment } from "../../state/threadHandoff";
import { startThreadHandoff } from "../threadHandoffMenu";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { handoffChoiceId, threadMoveDialogCopy } from "./threadMoveDialog.logic";

/** Asks before moving a started thread to the machine its switch points away from. */
export function ThreadMoveDialog({
  environmentId,
  threadId,
  sourceLabel,
  target,
  running,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sourceLabel: string;
  readonly target: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly running: boolean;
  readonly onClose: () => void;
}) {
  const result = useAtomValue(
    threadHandoffEnvironment.options({ environmentId, input: { threadId } }),
  );
  const copy = threadMoveDialogCopy({
    sourceLabel,
    target,
    running,
    options: AsyncResult.isSuccess(result)
      ? result.value.options
      : AsyncResult.isFailure(result)
        ? "failed"
        : undefined,
  });
  const move = (projectId?: string) => {
    onClose();
    void startThreadHandoff(
      environmentId,
      threadId,
      handoffChoiceId({ environmentId: target.environmentId, projectId }),
    );
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {copy.canMove ? "Keep it here" : "Close"}
          </AlertDialogClose>
          {copy.choices.map((choice) => (
            <Button key={choice.projectId} onClick={() => move(choice.projectId)}>
              Move to {choice.title}
            </Button>
          ))}
          {copy.canMove ? <Button onClick={() => move()}>Move to {target.label}</Button> : null}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
