import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import { FormEvent, useEffect, useState } from 'react';
import { Proposal } from './model';

type TemplateId = 'nodejs-api' | 'fastapi-api' | 'scheduled-worker';

type FormValues = {
  declaredIntent: string;
  templateId: TemplateId;
  serviceName: string;
  requestedOwner: string;
  description: string;
  schedule: string;
};

type CatalogGroup = {
  kind?: string;
  metadata?: { name?: string; namespace?: string; title?: string };
};

const templates: Array<{
  id: TemplateId;
  title: string;
  description: string;
  output: string;
}> = [
  {
    id: 'nodejs-api',
    title: 'Internal Node.js API',
    description: 'Always-running HTTP service',
    output: 'Deployment + ClusterIP',
  },
  {
    id: 'fastapi-api',
    title: 'Internal FastAPI service',
    description: 'Python HTTP service',
    output: 'Deployment + ClusterIP',
  },
  {
    id: 'scheduled-worker',
    title: 'Scheduled worker',
    description: 'Background job on a schedule',
    output: 'Kubernetes CronJob',
  },
];

const initialValues: FormValues = {
  declaredIntent: '',
  templateId: 'nodejs-api',
  serviceName: '',
  requestedOwner: '',
  description: '',
  schedule: '',
};

function validate(values: FormValues): string | null {
  if (
    values.declaredIntent.trim().length < 12 ||
    values.declaredIntent.trim().length > 1000
  ) {
    return 'Describe your intent in 12–1000 characters.';
  }
  if (
    !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(values.serviceName.trim()) ||
    values.serviceName.trim().length < 2 ||
    values.serviceName.trim().length > 63
  ) {
    return 'Use a lowercase service name, 2–63 characters, with optional hyphens.';
  }
  if (
    !/^group:default\/[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(
      values.requestedOwner.trim(),
    )
  ) {
    return 'Use a catalog owner such as group:default/payments-team.';
  }
  if (
    values.description.trim().length < 3 ||
    values.description.trim().length > 500
  ) {
    return 'Write a description of 3–500 characters.';
  }
  if (
    values.templateId === 'scheduled-worker' &&
    !/^([*0-9,/\-]+\s+){4}[*0-9,/\-]+$/.test(values.schedule.trim())
  ) {
    return 'Use a five-field cron schedule for the worker.';
  }
  if (
    values.templateId === 'scheduled-worker' &&
    (values.schedule.trim().length < 9 || values.schedule.trim().length > 100)
  ) {
    return 'Use a cron schedule of 9–100 characters.';
  }
  return null;
}

export function CreateProposalForm({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: (proposal: Proposal) => void;
}) {
  const { fetch } = useApi(fetchApiRef);
  const [values, setValues] = useState<FormValues>(initialValues);
  const [groups, setGroups] = useState<Array<{ ref: string; title: string }>>(
    [],
  );
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('plugin://catalog/entities?filter=kind%3DGroup')
      .then(async response => {
        if (!response.ok) throw new Error('Catalog groups unavailable');
        return (await response.json()) as unknown;
      })
      .then(data => {
        if (!active) return;
        const entities = Array.isArray(data) ? (data as CatalogGroup[]) : [];
        const options = entities
          .flatMap(entity => {
            const name = entity.metadata?.name;
            if (
              entity.kind?.toLowerCase() !== 'group' ||
              (entity.metadata?.namespace ?? 'default') !== 'default' ||
              !name
            ) {
              return [];
            }
            return [
              {
                ref: `group:default/${name}`,
                title: entity.metadata?.title ?? name,
              },
            ];
          })
          .sort((left, right) => left.ref.localeCompare(right.ref));
        if (options.length > 0) setGroups(options);
      })
      .catch(() => {
        if (active) setCatalogUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [fetch]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const validationError = validate(values);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSubmitting(true);
    const body = {
      declaredIntent: values.declaredIntent.trim(),
      templateId: values.templateId,
      inputs: {
        serviceName: values.serviceName.trim(),
        requestedOwner: values.requestedOwner.trim(),
        environment: 'staging',
        description: values.description.trim(),
        ...(values.templateId === 'scheduled-worker'
          ? { schedule: values.schedule.trim() }
          : {}),
      },
    };
    try {
      const response = await fetch('plugin://agent-guard/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as {
        error?: { message?: string };
        message?: string;
      };
      if (!response.ok) {
        throw new Error(
          result.error?.message ??
            result.message ??
            `Proposal request failed (${response.status}). Check the queue before retrying.`,
        );
      }
      onSubmitted(result as Proposal);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm submission. Check the queue before retrying.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      id="ag-create-form"
      className="ag-card ag-create"
      aria-labelledby="ag-create-title"
    >
      <div className="ag-section-heading">
        <div>
          <span className="ag-eyebrow">New governed request</span>
          <h2 id="ag-create-title">Create a service proposal</h2>
          <p className="ag-muted">
            Choose a trusted template and describe the change. This submits a
            proposal; it does not run Scaffolder or deploy anything.
          </p>
        </div>
        <a href="/create">Browse platform templates</a>
      </div>

      <form onSubmit={submit} noValidate>
        <fieldset disabled={submitting}>
          <legend className="ag-visually-hidden">Proposal details</legend>
          <div className="ag-create__section-heading">
            <span>01</span>
            <div>
              <h3>Choose a template</h3>
              <p>Only these platform-owned staging templates are supported.</p>
            </div>
          </div>
          <div className="ag-create__templates">
            {templates.map(template => (
              <label
                key={template.id}
                className={`ag-create__template ${
                  values.templateId === template.id
                    ? 'ag-create__template--selected'
                    : ''
                }`}
              >
                <input
                  type="radio"
                  name="template"
                  value={template.id}
                  checked={values.templateId === template.id}
                  onChange={() =>
                    setValues(current => ({
                      ...current,
                      templateId: template.id,
                    }))
                  }
                />
                <strong>{template.title}</strong>
                <span>{template.description}</span>
                <small>{template.output}</small>
              </label>
            ))}
          </div>

          <div className="ag-create__section-heading">
            <span>02</span>
            <div>
              <h3>Describe the request</h3>
              <p>Jev compares your declared intent with the chosen action.</p>
            </div>
          </div>
          <div className="ag-create__fields">
            <label className="ag-create__field ag-create__field--wide">
              <span>Declared intent</span>
              <textarea
                name="declaredIntent"
                rows={3}
                required
                minLength={12}
                maxLength={1000}
                value={values.declaredIntent}
                placeholder="Create an internal staging Node.js API for the payments team, with no public ingress or database."
                onChange={event =>
                  setValues(current => ({
                    ...current,
                    declaredIntent: event.target.value,
                  }))
                }
              />
              <small>
                This is your submitted statement, not cryptographic proof of who
                wrote the original request.
              </small>
            </label>
            <label className="ag-create__field">
              <span>Service name</span>
              <input
                name="serviceName"
                required
                maxLength={63}
                value={values.serviceName}
                placeholder="payments-api"
                onChange={event =>
                  setValues(current => ({
                    ...current,
                    serviceName: event.target.value,
                  }))
                }
              />
              <small>Lowercase letters, numbers, and hyphens.</small>
            </label>
            <label className="ag-create__field">
              <span>Owner group</span>
              <input
                name="requestedOwner"
                required
                list="ag-catalog-groups"
                value={values.requestedOwner}
                placeholder="group:default/payments-team"
                onChange={event =>
                  setValues(current => ({
                    ...current,
                    requestedOwner: event.target.value,
                  }))
                }
              />
              <datalist id="ag-catalog-groups">
                {groups.map(group => (
                  <option
                    key={group.ref}
                    value={group.ref}
                    label={group.title}
                  />
                ))}
              </datalist>
              <small>
                {catalogUnavailable
                  ? 'Catalog suggestions unavailable; the backend still validates the owner.'
                  : 'Choose an existing Catalog Group; a different member must review.'}
              </small>
            </label>
            <label className="ag-create__field ag-create__field--wide">
              <span>Description</span>
              <input
                name="description"
                required
                maxLength={500}
                value={values.description}
                placeholder="Internal payments API for the staging environment"
                onChange={event =>
                  setValues(current => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </label>
            {values.templateId === 'scheduled-worker' && (
              <label className="ag-create__field">
                <span>Five-field cron schedule</span>
                <input
                  name="schedule"
                  required
                  maxLength={100}
                  value={values.schedule}
                  placeholder="0 2 * * *"
                  onChange={event =>
                    setValues(current => ({
                      ...current,
                      schedule: event.target.value,
                    }))
                  }
                />
              </label>
            )}
            <div className="ag-create__environment">
              <span>Environment</span>
              <strong>Staging only</strong>
              <small>
                Production and arbitrary cluster targets are not supported.
              </small>
            </div>
          </div>

          <div className="ag-create__footer">
            <div className="ag-create__guardrail">
              <strong>What happens next</strong>
              <span>
                Jev checks semantic alignment; deterministic policy routes the
                request. A distinct owner reviewer must approve the exact frozen
                files before Scaffolder can start.
              </span>
            </div>
            {error && (
              <div className="ag-notice ag-notice--error" role="alert">
                {error}
              </div>
            )}
            <div className="ag-create__actions">
              <button
                className="ag-button"
                type="button"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                className="ag-button ag-button--primary"
                type="submit"
                disabled={submitting}
              >
                {submitting ? 'Submitting…' : 'Submit for semantic review'}
              </button>
            </div>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
