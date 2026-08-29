import type { HTMLAttributes } from "react";

export function Badge({tone="neutral",className="",...props}:HTMLAttributes<HTMLSpanElement>&{tone?:"neutral"|"info"|"success"|"warning"|"danger"}){
  return <span className={`ui-badge ui-badge-${tone} ${className}`} {...props}/>;
}
