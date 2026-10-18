/**
 * A scheduled run's prompt is recorded as a user-role message, but the user did not just write
 * it: an agent must not read it as a fresh instruction or as the answer to its own question.
 * Turn starts and steers both frame it this way, so no provider sees it bare.
 */
export const SCHEDULED_TASK_NOTE =
  "The message below is a scheduled task's prompt, sent by T3 Code on the task's schedule. It is not a new message from the user: treat it as a routine trigger, not as a new instruction or as the user's answer to anything you asked them.";

export const SCHEDULED_TASK_PROMPT_LABEL = "Scheduled task prompt";

export const frameScheduledTaskPrompt = (text: string) =>
  `${SCHEDULED_TASK_NOTE}\n\n${SCHEDULED_TASK_PROMPT_LABEL}:\n${text}`;
