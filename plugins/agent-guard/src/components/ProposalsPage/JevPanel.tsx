import { humanize, SemanticResult, Tone } from './model';

function scoreTone(score: number): Tone {
  if (score > 1.5) return 'negative';
  if (score > 1) return 'warning';
  return 'positive';
}

function Gauge({
  label,
  value,
  max,
  valueLabel,
  caption,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  valueLabel: string;
  caption: string;
  tone: Tone;
}) {
  const bounded = Math.min(max, Math.max(0, value));
  return (
    <div
      className={`ag-gauge ag-gauge--${tone}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={bounded}
      aria-valuetext={valueLabel}
    >
      <svg viewBox="0 0 200 118" aria-hidden="true" focusable="false">
        <path className="ag-gauge__track" d="M 20 100 A 80 80 0 0 1 180 100" />
        <path
          className="ag-gauge__fill"
          d="M 20 100 A 80 80 0 0 1 180 100"
          pathLength={100}
          strokeDasharray={`${(bounded / max) * 100} 100`}
        />
      </svg>
      <div className="ag-gauge__reading">
        <strong>{valueLabel}</strong>
        <span>{caption}</span>
      </div>
    </div>
  );
}

export function JevPanel({ semantic }: { semantic: SemanticResult }) {
  return (
    <section className="ag-card ag-jev" aria-labelledby="ag-jev-heading">
      <div className="ag-section-heading">
        <div>
          <span className="ag-eyebrow">Semantic evidence</span>
          <h3 id="ag-jev-heading">Jev insight</h3>
        </div>
        <span className="ag-pill ag-pill--neutral">Advisory, not approval</span>
      </div>
      {semantic.kind === 'unavailable' ? (
        <div className="ag-notice ag-notice--warning" role="status">
          Jev is unavailable ({humanize(semantic.reason)}). This proposal cannot
          be approved.
        </div>
      ) : (
        <>
          <div className="ag-jev__grid">
            <div className="ag-signal">
              <span className="ag-signal__label">Choice</span>
              <div className="ag-choice">
                <span
                  className={`ag-choice__dot ag-choice__dot--${
                    semantic.choice === 'aligned' ? 'positive' : 'warning'
                  }`}
                  aria-hidden="true"
                />
                <strong>{humanize(semantic.choice)}</strong>
              </div>
              <p>Primary classification</p>
              <div className="ag-confidence">
                <span>Confidence</span>
                <strong>{Math.round(semantic.choiceConfidence * 100)}%</strong>
              </div>
              <div className="ag-confidence__track" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(0, semantic.choiceConfidence * 100),
                    )}%`,
                  }}
                />
              </div>
            </div>
            <div className="ag-signal">
              <span className="ag-signal__label">Noul</span>
              <Gauge
                label="Noul yes probability"
                value={semantic.noul * 100}
                max={100}
                valueLabel={`${Math.round(semantic.noul * 100)}%`}
                caption="yes probability"
                tone={semantic.noul >= 0.5 ? 'positive' : 'warning'}
              />
              <p>Does this preserve the declared intent?</p>
            </div>
            <div className="ag-signal">
              <span className="ag-signal__label">Score</span>
              <Gauge
                label="Semantic mismatch severity score"
                value={semantic.score}
                max={4}
                valueLabel={semantic.score.toFixed(2)}
                caption="of 4 mismatch severity"
                tone={scoreTone(semantic.score)}
              />
              <p>Lower means less mismatch, not lower operational risk.</p>
            </div>
          </div>
          <details className="ag-disclosure">
            <summary>Model distributions and scoring rubric</summary>
            <div className="ag-disclosure__body ag-distributions">
              <div>
                <h4>Choice probabilities</h4>
                <dl>
                  {Object.entries(semantic.choiceProbabilities).map(
                    ([choice, probability]) => (
                      <div key={choice}>
                        <dt>{humanize(choice)}</dt>
                        <dd>{Math.round(probability * 100)}%</dd>
                      </div>
                    ),
                  )}
                </dl>
              </div>
              <div>
                <h4>Score distribution</h4>
                <dl>
                  {Object.entries(semantic.scoreProbabilities).map(
                    ([score, probability]) => (
                      <div key={score}>
                        <dt>
                          {score} —{' '}
                          {semantic.scoreLegend[score] ?? 'Unlabelled'}
                        </dt>
                        <dd>{Math.round(probability * 100)}%</dd>
                      </div>
                    ),
                  )}
                </dl>
              </div>
              <p className="ag-muted">Model: {semantic.model}</p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
