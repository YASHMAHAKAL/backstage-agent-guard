export interface Config {
  agentGuard?: {
    rizzCloud?: {
      enabled?: boolean;
      awsProfile?: string;
      /** @visibility secret */
      githubToken?: string;
      submitterGroups?: string[];
      delivery?: {
        enabled?: boolean;
        destinationServer?: string;
      };
      target?: {
        id: string;
        accountId: string;
        region: string;
        clusterName: string;
        namespace: string;
        owner: string;
        sourceRepository: string;
        gitopsRepository: string;
        gitopsBranch: string;
        gitopsPath: string;
        argoApplication: string;
        ingress: {
          operatorCidr: string;
        };
      };
    };
    rizzReleases?: {
      enabled?: boolean;
      repository?: string;
      frontendRepository?: string;
      backendRepository?: string;
      awsProfile?: string;
      /** @visibility secret */
      githubToken?: string;
    };
  };
}
