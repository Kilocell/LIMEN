import { useCallback, useEffect, useRef, useState } from "react";
import { type BenchConfig, type BenchReport, type LinkRow } from "@/lib/limen";
import { ratingLabel, type Assessment, type Dimension, type MediumAssessment, type Rating, type SensitivityVerdict } from "@/lib/assess";
import { frontierCsv, reportFileName, reportJson, reportMarkdown, type ReportInput } from "@/lib/report";
import { sensitivityAsync, type SensitivityReport } from "@/lib/sensitivity";

type Frontier = { rows: readonly LinkRow[]; crossoverCm: number | null };

/**
 * Sensitivity is slow enough (about a second) to run on request, so it lives here. A result
 * belongs to the exact config it was run on; once the board changes it is stale and is not returned.
 */
export function useSensitivity(config: BenchConfig) {
  const [state, setState] = useState<{ config: BenchConfig; result: SensitivityReport } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const signal = useRef({ cancelled: false });

  // A change to the board stops a run that is still going.
  useEffect(() => {
    signal.current.cancelled = true;
    setProgress(null);
  }, [config]);

  const run = useCallback(async () => {
    signal.current.cancelled = true;
    const mine = { cancelled: false };
    signal.current = mine;
    setProgress(0);
    const result = await sensitivityAsync(config, (done) => {
      if (!mine.cancelled) setProgress(done);
    }, mine);
    if (mine.cancelled) return;
    if (result) setState({ config, result });
    setProgress(null);
  }, [config]);

  const fresh = state !== null && state.config === config ? state.result : null;
  return { result: fresh, stale: state !== null && fresh === null, progress, run };
}

const VERDICT: Record<SensitivityVerdict, { rating: Rating; label: string }> = {
  robust: { rating: "excellent", label: "Robust" },
  sensitive: { rating: "fair", label: "Sensitive" },
  fragile: { rating: "poor", label: "Fragile" },
};

function Chip({ dimension, rating }: { dimension: Dimension; rating: Rating }) {
  return <span className={`rate rate-${rating}`}>{ratingLabel(dimension, rating)}</span>;
}

function MediumRow({ name, m, qTarget }: { name: string; m: MediumAssessment; qTarget: number }) {
  if (!m.present) {
    return (
      <tr>
        <th scope="row">{name}</th>
        <td colSpan={4} className="muted">
          off
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>
        <Chip dimension="stability" rating={m.stability} />
      </td>
      <td>
        <Chip dimension="efficiency" rating={m.efficiency} />
      </td>
      <td>{m.qRatio === null ? "—" : `${(m.qRatio * qTarget).toFixed(1)}`}</td>
      <td>{m.pjPerBit === null ? "—" : m.pjPerBit.toFixed(1)}</td>
    </tr>
  );
}

/** The class of the connection, with the reasons behind it. */
export function StatusBlock({ assessment: a }: { assessment: Assessment }) {
  return (
    <section id="link-status" className="status-block" aria-labelledby="link-status-title" tabIndex={-1}>
      <h2 id="link-status-title">Link status</h2>
      <p className="status-overall">
        <Chip dimension="overall" rating={a.overall} />
        <span>
          {a.cheaper === null ? "no medium works" : `cheaper working medium at ${a.lengthCm} cm: ${a.cheaper}`}
        </span>
      </p>
      <table className="status-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Medium</span>
            </th>
            <th scope="col">Stability</th>
            <th scope="col">Efficiency</th>
            <th scope="col">Q</th>
            <th scope="col">pJ/bit</th>
          </tr>
        </thead>
        <tbody>
          <MediumRow name="Copper" m={a.copper} qTarget={a.qTarget} />
          <MediumRow name="Optical" m={a.optical} qTarget={a.qTarget} />
        </tbody>
      </table>
      <p className="hint">Q target {a.qTarget.toFixed(1)}. Classes are chosen for this model, not taken from a standard.</p>
      {a.findings.length > 0 ? (
        <ul className="status-findings">
          {a.findings.map((f, index) => (
            <li key={index} className={`level-${f.level}`}>
              <b>{f.level === "alert" ? "Alert" : f.level === "warn" ? "Warning" : "Note"}</b> {f.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function download(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sensitivity of the board to the assumed constants, and the report export. */
export function ReportBlock({
  report,
  frontier,
  assessment,
  presetLabel,
  sensitivity,
}: {
  report: BenchReport;
  frontier: Frontier;
  assessment: Assessment;
  presetLabel: string | null;
  sensitivity: ReturnType<typeof useSensitivity>;
}) {
  const { result, stale, progress, run } = sensitivity;
  const running = progress !== null;

  function save(kind: "md" | "json" | "csv") {
    const input: ReportInput = { generatedAt: new Date().toISOString(), presetLabel, report, frontier, assessment, sensitivity: result };
    const name = reportFileName(input, kind);
    if (kind === "md") download(name, reportMarkdown(input), "text/markdown");
    else if (kind === "json") download(name, reportJson(input), "application/json");
    else download(name, frontierCsv(frontier.rows), "text/csv");
  }

  const changed = result ? result.rows.filter((r) => r.effect !== "stable") : [];
  const verdict = result ? VERDICT[result.verdict] : null;

  return (
    <section className="report-block" aria-labelledby="report-title">
      <h2 id="report-title">Sensitivity and report</h2>
      <p className="hint">
        Moves each assumed constant 25 % down and up, one at a time, and solves this board again. It takes about a second.
      </p>
      <div className="report-actions">
        <button type="button" onClick={run} disabled={running}>
          {running ? "Running…" : result ? "Run again" : "Run sensitivity"}
        </button>
        {running ? <progress max={1} value={progress ?? 0} aria-label="Sensitivity progress" /> : null}
      </div>
      {stale && !running ? <p className="hint">The board changed since the last run. Run it again for current results.</p> : null}
      <div role="status" aria-live="polite">
        {result && verdict ? (
          <>
            <p className="status-overall">
              <span className={`rate rate-${verdict.rating}`}>{verdict.label}</span>
              <span>
                {result.verdict === "robust"
                  ? "no conclusion changes"
                  : result.verdict === "sensitive"
                    ? "a conclusion changes, no link goes down"
                    : "a working link goes down"}
              </span>
            </p>
            {changed.length > 0 ? (
              <table className="status-table sens-table">
                <thead>
                  <tr>
                    <th scope="col">Constant</th>
                    <th scope="col">Value</th>
                    <th scope="col">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {changed.map((r) => (
                    <tr key={`${r.key}-${r.scale}`}>
                      <th scope="row">{r.label}</th>
                      <td>
                        {Number(r.value.toPrecision(3))} {r.unit}
                      </td>
                      <td className={r.effect === "flips" ? "level-warn" : ""}>{[...r.flips, ...r.shifts].join(" ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="hint">No constant changed a result.</p>
            )}
            {result.inert.length > 0 ? (
              <p className="hint">
                Changed nothing here: {result.inert.map((key) => result.rows.find((r) => r.key === key)?.label ?? key).join(", ")}.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="report-actions" role="group" aria-label="Export">
        <button type="button" onClick={() => save("md")}>
          Report .md
        </button>
        <button type="button" onClick={() => save("json")}>
          Data .json
        </button>
        <button type="button" onClick={() => save("csv")}>
          Sweep .csv
        </button>
      </div>
      <p className="hint">{result ? "The report and the data file include the sensitivity results." : "Run the sensitivity first to include it in the report."}</p>
    </section>
  );
}
