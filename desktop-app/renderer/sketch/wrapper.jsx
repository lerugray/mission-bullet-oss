// mission-bullet — Excalidraw bundle wrapper (mb-012)
//
// The rest of the renderer runs React 18 via unpkg UMD + Babel-standalone
// in-browser JSX transform (deliberate: no build step). Excalidraw can't
// realistically live in that setup — it imports CSS, ships as ESM, and
// expects a bundler-resolved react.
//
// So the sketch surface is the only thing that gets a build step: esbuild
// produces `sketch/bundle.js` + `sketch/bundle.css` from this file. The
// bundle exposes a tiny imperative API on `window.MBSketch`:
//
//   const handle = MBSketch.mount(hostEl, { initialData, onChange, theme })
//   handle.unmount()
//
// The React instance inside this bundle is separate from the window.React
// used by app.jsx. That's fine — no React state is shared across the
// boundary; the host passes plain-data initialData in, gets plain-data
// `{ elements, appState, files }` out of onChange.

import React from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, exportToSvg } from "@excalidraw/excalidraw";
// Excalidraw 0.17.x injects its own stylesheet via a runtime <style> tag
// when the bundle evaluates, so no import of an .css file is required.
// Fonts and language data live in dist/excalidraw-assets/ — they're
// copied into renderer/sketch/excalidraw-assets/ at build time and
// pointed at via window.EXCALIDRAW_ASSET_PATH before this bundle loads.

// Cream + rust palette. Mirrors --bg / --accent in styles.css so the
// canvas feels continuous with the rest of the app. Sketches get a dot
// grid (gridModeEnabled) with snap-to-grid on by default — load-bearing
// for the user's game-design grid drawings where misaligned tiles defeat the
// whole point.
// Theme-specific defaults. Light keeps the cream paper look; dark
// uses a warm bg from the app's dark palette so the canvas reads as
// a continuation of the rest of the UI rather than a stark window
// into a different design.
const APP_STATE_LIGHT = {
  viewBackgroundColor: "#f6eee3",
  currentItemStrokeColor: "#7a3b1e",
  currentItemBackgroundColor: "transparent",
  currentItemFontFamily: 1,
  gridModeEnabled: true,
  gridSize: 20,
  theme: "light",
  zenModeEnabled: false,
};
const APP_STATE_DARK = {
  ...APP_STATE_LIGHT,
  viewBackgroundColor: "#2b2519",
  currentItemStrokeColor: "#e8dfd0",
  theme: "dark",
};

function SketchHost({ initialData, onChange, theme }) {
  const seed = React.useMemo(() => {
    const elements = Array.isArray(initialData?.elements) ? initialData.elements : [];
    const base = theme === "dark" ? APP_STATE_DARK : APP_STATE_LIGHT;
    const appState = {
      ...base,
      ...(initialData?.appState || {}),
      // Always enforce our look; don't let a stale saved appState
      // override the dot-grid or theme background.
      viewBackgroundColor: base.viewBackgroundColor,
      theme: base.theme,
      gridModeEnabled: true,
      gridSize:
        typeof initialData?.appState?.gridSize === "number"
          ? initialData.appState.gridSize
          : base.gridSize,
      // Excalidraw refuses to mount if collaborators is anything other
      // than a Map. Saved JSON has it as []/undefined after a round-trip.
      collaborators: new Map(),
    };
    const files = initialData?.files && typeof initialData.files === "object" ? initialData.files : {};
    return { elements, appState, files };
  }, [initialData, theme]);

  return React.createElement(
    "div",
    { style: { position: "absolute", inset: 0 } },
    React.createElement(Excalidraw, {
      initialData: seed,
      // Top-level `theme` prop drives Excalidraw's UI chrome (toolbar
      // and sidebar). NOTE: dark-mode users still see a cream canvas
      // under dark UI chrome — Excalidraw v0.17.6 ignores
      // viewBackgroundColor in initialData.appState, and explicit
      // updateScene calls via the excalidrawAPI ref don't repaint
      // either. Needs interactive devtools time to root-cause; flagged
      // to revisit. The other half of this fix lives in app.jsx where
      // SketchView now takes `dark` as a prop instead of reading
      // data-theme during a child useEffect (which raced App's effect
      // and saw an unset attribute).
      theme: theme === "dark" ? "dark" : "light",
      onChange: (elements, appState, files) => {
        if (typeof onChange === "function") {
          onChange({ elements, appState, files });
        }
      },
      gridModeEnabled: true,
      UIOptions: {
        canvasActions: {
          // The journal IS the store — disabling the Excalidraw-side
          // "open/save" buttons keeps the flow one-way: we load from
          // DD.sketch.excalidraw on mount, save via onChange, and never
          // leak a second source-of-truth through the UI.
          loadScene: false,
          saveToActiveFile: false,
          saveAsImage: true,
          export: false,
          clearCanvas: true,
          changeViewBackgroundColor: false,
          toggleTheme: false,
        },
      },
    }),
  );
}

function mount(hostEl, { initialData, onChange, theme } = {}) {
  if (!hostEl || typeof hostEl !== "object") {
    throw new Error("MBSketch.mount: hostEl required");
  }
  const root = createRoot(hostEl);
  root.render(
    React.createElement(SketchHost, { initialData, onChange, theme }),
  );
  return {
    unmount: () => {
      try { root.unmount(); } catch (_) { /* already unmounted */ }
    },
  };
}

if (typeof window !== "undefined") {
  window.MBSketch = { mount, exportToSvg };
}
