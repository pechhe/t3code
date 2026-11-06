import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Text cut to a few lines, with the whole of it on hover. */
export function ClampedText(props: {
  readonly text: string;
  readonly className: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<p className={props.className} />}>
        {props.children ?? props.text}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <p className="max-w-96 whitespace-pre-wrap">{props.text}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
