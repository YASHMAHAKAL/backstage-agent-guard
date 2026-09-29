import { createHash } from 'node:crypto';
import { ProposalInput } from './domain';

// Argo CD renders the shared apps/staging directory in directory-recursion
// mode. Service folders deliberately contain only Kubernetes manifests; the
// Backstage catalog descriptor is excluded by the platform-owned Application.
const TEMPLATE_VERSION = 'agent-guard-v4-shared-staging-directory';
// Approval under the older review-only policy must never become permission to
// start a Scaffolder task after this feature is installed.
const POLICY_VERSION = 'staging-review-v5-guarded-pr';

export interface FrozenFile {
  path: string;
  content: string;
  sha256: string;
}

export type SubmissionChannel = 'mcp_action' | 'backstage_rest';
export type IntentSource = 'agent_supplied' | 'authenticated_user_submitted';

export interface ApprovalEnvelope {
  // Version 1 snapshots predate submission-channel recording. Preserve their
  // exact shape so historical approval digests remain valid.
  schemaVersion: 1 | 2;
  proposalId: string;
  declaredIntent: string;
  intentSource: IntentSource;
  submissionChannel?: SubmissionChannel;
  requester: string;
  template: {
    id: ProposalInput['templateId'];
    version: string;
    digest: string;
  };
  inputs: ProposalInput['inputs'];
  environment: 'staging';
  gitopsTarget: {
    repository: string;
    branch: 'main';
    path: string;
    publishEnabled: boolean;
  };
  generatedFiles: Array<{ path: string; sha256: string }>;
  policyVersion: string;
}

export interface FrozenSnapshot {
  envelope: ApprovalEnvelope;
  digest: string;
  files: FrozenFile[];
}

const commonCatalogInfo = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: \${{ values.serviceName }}
  annotations:
    backstage.io/kubernetes-id: \${{ values.serviceName }}
    backstage.io/kubernetes-namespace: staging
spec:
  type: service
  lifecycle: staging
  owner: \${{ values.requestedOwner }}
`;

const service = `apiVersion: v1
kind: Service
metadata:
  name: \${{ values.serviceName }}
  namespace: staging
  labels:
    backstage.io/kubernetes-id: \${{ values.serviceName }}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: \${{ values.serviceName }}
  ports:
    - name: http
      port: 80
      targetPort: http
`;

const templateSources: Record<
  ProposalInput['templateId'],
  Record<string, string>
> = {
  'nodejs-api': {
    'catalog-info.yaml': commonCatalogInfo,
    'deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${{ values.serviceName }}
  namespace: staging
  labels:
    app.kubernetes.io/name: \${{ values.serviceName }}
    backstage.io/kubernetes-id: \${{ values.serviceName }}
spec:
  replicas: \${{ values.replicas }}
  selector:
    matchLabels:
      app.kubernetes.io/name: \${{ values.serviceName }}
      backstage.io/kubernetes-id: \${{ values.serviceName }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: \${{ values.serviceName }}
        backstage.io/kubernetes-id: \${{ values.serviceName }}
    spec:
      containers:
        - name: api
          image: docker.io/library/node@sha256:f2dc6eea95f787e25f173ba9904c9d0647ab2506178c7b5b7c5a3d02bc4af145
          imagePullPolicy: IfNotPresent
          command: [node, -e]
          args:
            - "require('http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({service:process.env.SERVICE_NAME,ok:true}))}).listen(8080,'0.0.0.0')"
          env:
            - name: SERVICE_NAME
              value: \${{ values.serviceName }}
          ports:
            - containerPort: 8080
              name: http
          readinessProbe:
            httpGet:
              path: /
              port: http
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
`,
    'service.yaml': service,
  },
  'fastapi-api': {
    'catalog-info.yaml': commonCatalogInfo,
    'configmap.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: \${{ values.serviceName }}-app
  namespace: staging
data:
  main.py: |
    import os
    from fastapi import FastAPI

    app = FastAPI()

    @app.get("/")
    def root():
        return {"service": os.environ["SERVICE_NAME"], "ok": True}
`,
    'deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${{ values.serviceName }}
  namespace: staging
  labels:
    app.kubernetes.io/name: \${{ values.serviceName }}
    backstage.io/kubernetes-id: \${{ values.serviceName }}
spec:
  replicas: \${{ values.replicas }}
  selector:
    matchLabels:
      app.kubernetes.io/name: \${{ values.serviceName }}
      backstage.io/kubernetes-id: \${{ values.serviceName }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: \${{ values.serviceName }}
        backstage.io/kubernetes-id: \${{ values.serviceName }}
    spec:
      containers:
        - name: api
          image: docker.io/tiangolo/uvicorn-gunicorn-fastapi@sha256:02ee7db41f9ae909476117de6d68cd51a8027decf6d49870f18ebcfedb23db3f
          imagePullPolicy: IfNotPresent
          command: [uvicorn, 'main:app', --host, '0.0.0.0', --port, '8000']
          workingDir: /app
          env:
            - name: SERVICE_NAME
              value: \${{ values.serviceName }}
          ports:
            - containerPort: 8000
              name: http
          readinessProbe:
            httpGet:
              path: /
              port: http
          volumeMounts:
            - name: app-code
              mountPath: /app/main.py
              subPath: main.py
              readOnly: true
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
      volumes:
        - name: app-code
          configMap:
            name: \${{ values.serviceName }}-app
`,
    'service.yaml': service,
  },
  'scheduled-worker': {
    'catalog-info.yaml': commonCatalogInfo,
    'cronjob.yaml': `apiVersion: batch/v1
kind: CronJob
metadata:
  name: \${{ values.serviceName }}
  namespace: staging
  labels:
    backstage.io/kubernetes-id: \${{ values.serviceName }}
spec:
  schedule: '\${{ values.schedule }}'
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            backstage.io/kubernetes-id: \${{ values.serviceName }}
        spec:
          restartPolicy: OnFailure
          containers:
            - name: worker
              image: docker.io/library/busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
              imagePullPolicy: IfNotPresent
              command: [sh, -c, 'echo scheduled demo task completed']
              resources:
                requests:
                  cpu: 10m
                  memory: 16Mi
                limits:
                  cpu: 100m
                  memory: 64Mi
`,
  },
};

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Cannot canonicalize non-JSON number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalize(item)).join(',')}]`;
  }
  if (
    typeof value !== 'object' ||
    Object.prototype.toString.call(value) !== '[object Object]'
  )
    throw new Error('Cannot canonicalize non-JSON value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

export function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function render(source: string, inputs: ProposalInput['inputs']): string {
  return source
    .replaceAll('${{ values.serviceName }}', inputs.serviceName)
    .replaceAll('${{ values.requestedOwner }}', inputs.requestedOwner)
    .replaceAll('${{ values.replicas }}', String(inputs.replicas ?? 1))
    .replaceAll('${{ values.schedule }}', inputs.schedule ?? '');
}

function templateDigest(templateId: ProposalInput['templateId']): string {
  return sha256(
    canonicalize({
      templateId,
      version: TEMPLATE_VERSION,
      sources: templateSources[templateId],
    }),
  );
}

export function createFrozenSnapshot(options: {
  proposalId: string;
  proposal: ProposalInput;
  requester: string;
  intentSource?: IntentSource;
  submissionChannel?: SubmissionChannel;
  gitopsRepoUrl?: string;
}): FrozenSnapshot {
  const basePath = `apps/staging/${options.proposal.inputs.serviceName}`;
  const files = Object.entries(templateSources[options.proposal.templateId])
    .map(([name, source]) => {
      const content = render(source, options.proposal.inputs);
      return {
        path: `${basePath}/${name}`,
        content,
        sha256: sha256(content),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const envelope: ApprovalEnvelope = {
    schemaVersion: options.submissionChannel ? 2 : 1,
    proposalId: options.proposalId,
    declaredIntent: options.proposal.declaredIntent,
    intentSource: options.intentSource ?? 'agent_supplied',
    ...(options.submissionChannel
      ? { submissionChannel: options.submissionChannel }
      : {}),
    requester: options.requester,
    template: {
      id: options.proposal.templateId,
      version: TEMPLATE_VERSION,
      digest: templateDigest(options.proposal.templateId),
    },
    inputs: options.proposal.inputs,
    environment: options.proposal.inputs.environment,
    gitopsTarget: {
      repository: options.gitopsRepoUrl ?? 'not-configured',
      branch: 'main',
      path: basePath,
      publishEnabled: Boolean(options.gitopsRepoUrl),
    },
    generatedFiles: files.map(file => ({
      path: file.path,
      sha256: file.sha256,
    })),
    policyVersion: POLICY_VERSION,
  };
  return {
    envelope,
    digest: sha256(canonicalize(envelope)),
    files,
  };
}

export function snapshotHasIntegrity(snapshot: FrozenSnapshot): boolean {
  const channelMatchesVersion =
    (snapshot.envelope.schemaVersion === 1 &&
      snapshot.envelope.submissionChannel === undefined) ||
    (snapshot.envelope.schemaVersion === 2 &&
      (snapshot.envelope.submissionChannel === 'mcp_action' ||
        snapshot.envelope.submissionChannel === 'backstage_rest'));
  const intentSourceMatchesChannel =
    snapshot.envelope.intentSource === 'agent_supplied' ||
    (snapshot.envelope.schemaVersion === 2 &&
      snapshot.envelope.submissionChannel === 'backstage_rest' &&
      snapshot.envelope.intentSource === 'authenticated_user_submitted');
  const fileHashesMatch = snapshot.files.every(
    file => sha256(file.content) === file.sha256,
  );
  const envelopeFilesMatch =
    canonicalize(snapshot.envelope.generatedFiles) ===
    canonicalize(
      snapshot.files.map(file => ({ path: file.path, sha256: file.sha256 })),
    );
  return (
    channelMatchesVersion &&
    intentSourceMatchesChannel &&
    fileHashesMatch &&
    envelopeFilesMatch &&
    sha256(canonicalize(snapshot.envelope)) === snapshot.digest
  );
}
