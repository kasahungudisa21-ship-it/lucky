"use client";

import { usePathname } from "next/navigation";

// Each route gets its own light. The scene is read from the address bar so a new page
// inherits a backdrop without having to know that the backdrop exists.
const SCENES: [RegExp, string][] = [
  [/^\/$/, "home"],
  [/^\/(login|register)/, "auth"],
  [/^\/houses\/[^/]+$/, "house"],
  [/^\/houses/, "houses"],
  [/^\/pay\//, "pay"],
  [/^\/me/, "me"],
  [/^\/draws/, "draws"],
  [/^\/admin/, "admin"],
];

export function Stage() {
  const path = usePathname();
  const scene = SCENES.find(([pattern]) => pattern.test(path))?.[1] ?? "page";

  return (
    <div className="stage" data-scene={scene} aria-hidden="true">
      <i className="stage__field" />
      <i className="stage__edge" />
      <i className="stage__fog" />
      <i className="stage__motif" />
      <i className="stage__rays" />
      <i className="stage__bokeh" />
      <i className="stage__bokeh stage__bokeh--far" />
      <i className="stage__spot" />
      <i className="stage__flare" />
      <i className="stage__grain" />
      <i className="stage__vig" />
    </div>
  );
}
