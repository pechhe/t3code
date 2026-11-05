import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

function useNavigateBack() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  return () => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  };
}

export function useEscapeToGoBack(onEscape?: () => void) {
  const navigateBack = useNavigateBack();
  const handleEscape = onEscape ?? navigateBack;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the scheduler Escape key listener while mounted
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key !== "Escape")
        return;
      event.preventDefault();

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      handleEscape();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleEscape]);
}
