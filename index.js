import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';
import { fromHttp } from '@aws-sdk/credential-providers';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { ECRPUBLICClient, GetAuthorizationTokenCommand as GetAuthorizationTokenCommandPublic } from '@aws-sdk/client-ecr-public';
import { SigninClient, CreateBearerTokenCommand } from '@aws-sdk/client-signin';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ECR_LOGIN_GITHUB_ACTION_USER_AGENT = 'amazon-ecr-login-for-github-actions';
const ECR_PUBLIC_REGISTRY_URI = 'public.ecr.aws';
const ECR_REGISTRY_ID_PATTERN = /^\d{12}$/;
const SIGNIN_GRANT_TYPE = 'client_credentials';
const SIGNIN_RESOURCE = 'ecr.amazonaws.com';

const INPUTS = {
  httpProxy: 'http-proxy',
  maskPassword: 'mask-password',
  registries: 'registries',
  registryType: 'registry-type',
  tokenType: 'ecr-private-token-type',
  skipLogout: 'skip-logout'
};

const OUTPUTS = {
  registry: 'registry',
  dockerUsername: 'docker_username',
  dockerPassword: 'docker_password'
};

const STATES = {
  registries: 'registries'
};

const REGISTRY_TYPES = {
  private: 'private',
  public: 'public'
};

const TOKEN_TYPES = {
  regional: 'regional-token',
  global: 'global-token'
};

function configureProxy(httpProxy) {
  const proxyFromEnv = process.env.HTTP_PROXY || process.env.http_proxy;

  if (httpProxy || proxyFromEnv) {
    let proxyToSet;

    if (httpProxy) {
      core.info(`Setting proxy from action input: ${httpProxy}`);
      proxyToSet = httpProxy;
    } else {
      core.info(`Setting proxy from environment: ${proxyFromEnv}`);
      proxyToSet = proxyFromEnv;
    }

    return new HttpsProxyAgent(proxyToSet);
  }
  return null;
}

function getCredentials() {
  // If explicit credentials are set (e.g. by configure-aws-credentials), let the default chain use them
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    core.info("Using environment variable credentials.");
    return undefined;
  }

  // If running in a Pod Identity environment (EKS Pod Identity)
  if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
    core.info("Using Pod Identity credentials via fromHttp()");
    return fromHttp();
  }

  // Use the default AWS SDK credential chain for other environments
  core.info("Using default AWS credential chain.");
  return undefined;
}

function getEcrClient(httpsProxyAgent) {
  return new ECRClient({
    customUserAgent: ECR_LOGIN_GITHUB_ACTION_USER_AGENT,
    credentials: getCredentials(), // Added credentials setting
    requestHandler: new NodeHttpHandler({
      httpAgent: httpsProxyAgent,
      httpsAgent: httpsProxyAgent
    }),
  });
}

async function getEcrAuthTokenWrapper(authTokenRequest, httpsProxyAgent) {
  const ecrClient = getEcrClient(httpsProxyAgent);
  const command = new GetAuthorizationTokenCommand(authTokenRequest);
  const authTokenResponse = await ecrClient.send(command);
  if (!authTokenResponse) {
    throw new Error('Amazon ECR authorization token returned no data');
  } else if (!authTokenResponse.authorizationData || !Array.isArray(authTokenResponse.authorizationData)) {
    throw new Error('Amazon ECR authorization token is invalid');
  } else if (!authTokenResponse.authorizationData.length) {
    throw new Error('Amazon ECR authorization token does not contain any authorization data');
  }

  return authTokenResponse;
}

function getEcrRegistryEndpoint(registryId, ecrApiHostname) {
  // Global mode constructs the Docker target locally, so validate before retrieving a token.
  if (!ECR_REGISTRY_ID_PATTERN.test(registryId)) {
    throw new Error(`Invalid ECR registry account ID: ${registryId}`);
  }

  const expectedPrefix = 'api.ecr.';
  /* istanbul ignore next -- guarded SDK endpoint-provider contract */
  if (!ecrApiHostname.startsWith(expectedPrefix)) {
    throw new Error(`Cannot derive an ECR registry endpoint from SDK endpoint ${ecrApiHostname}`);
  }
  return `https://${registryId}.dkr.ecr.${ecrApiHostname.slice(expectedPrefix.length)}`;
}

async function getEcrGlobalAuthTokenWrapper(registryIds, httpsProxyAgent) {
  const ecrClient = getEcrClient(httpsProxyAgent);
  const region = await ecrClient.config.region();
  const useFipsEndpoint = await ecrClient.config.useFipsEndpoint();
  if (useFipsEndpoint) {
    throw new Error(
      `'${TOKEN_TYPES.global}' does not support FIPS endpoints because ` +
      'SignIn CreateBearerToken does not support FIPS');
  }

  // Match the regional-token interface: registries selects accounts and the
  // configured SDK region selects the regional registry endpoints.
  if (!registryIds.length) {
    throw new Error(`'${INPUTS.registries}' is required for '${TOKEN_TYPES.global}'`);
  }

  // The regional API endpoint settings do not change the Docker registry
  // hostname returned by GetAuthorizationToken, so keep the standard endpoint.
  const ecrApiEndpoint = await ecrClient.config.endpointProvider({
    Region: region,
    UseFIPS: false,
    UseDualStack: false
  });
  const proxyEndpoints = registryIds.map(
    (accountId) => getEcrRegistryEndpoint(
      accountId, ecrApiEndpoint.url.hostname));

  const signinClient = new SigninClient({
    customUserAgent: ECR_LOGIN_GITHUB_ACTION_USER_AGENT,
    credentials: getCredentials(),
    ignoreConfiguredEndpointUrls: true,
    region,
    requestHandler: new NodeHttpHandler({
      httpAgent: httpsProxyAgent,
      httpsAgent: httpsProxyAgent
    }),
  });
  const command = new CreateBearerTokenCommand({
    grantType: SIGNIN_GRANT_TYPE,
    resource: SIGNIN_RESOURCE
  });
  const bearerTokenResponse = await signinClient.send(command);
  if (!bearerTokenResponse) {
    throw new Error('Amazon SignIn bearer token returned no data');
  } else if (!bearerTokenResponse.accessToken) {
    throw new Error('Amazon SignIn bearer token is invalid');
  }

  return {
    authorizationData: proxyEndpoints.map((proxyEndpoint) => ({
      username: 'AWS',
      password: bearerTokenResponse.accessToken,
      proxyEndpoint
    }))
  };
}

async function getEcrPublicAuthTokenWrapper(authTokenRequest, httpsProxyAgent) {
  const ecrPublicClient = new ECRPUBLICClient({
    customUserAgent: ECR_LOGIN_GITHUB_ACTION_USER_AGENT,
    // Authenticating to ECR Public auth only works in us-east-1
    region: "us-east-1",
    credentials: getCredentials(),
    requestHandler: new NodeHttpHandler({
      httpAgent: httpsProxyAgent,
      httpsAgent: httpsProxyAgent
    }),
  });
  const command = new GetAuthorizationTokenCommandPublic(authTokenRequest);
  const authTokenResponse = await ecrPublicClient.send(command);
  if (!authTokenResponse) {
    throw new Error('Amazon ECR Public authorization token returned no data');
  } else if (!authTokenResponse.authorizationData) {
    throw new Error('Amazon ECR Public authorization token is invalid');
  } else if (Object.keys(authTokenResponse.authorizationData).length === 0) {
    throw new Error('Amazon ECR Public authorization token does not contain any authorization data');
  }

  return {
    authorizationData: [
      {
        authorizationToken: authTokenResponse.authorizationData.authorizationToken,
        proxyEndpoint: ECR_PUBLIC_REGISTRY_URI
      }
    ]
  };
}

function replaceSpecialCharacters(registryUri) {
  return registryUri.replace(/[^a-zA-Z0-9_]+/g, '_');
}

async function run() {
  // Get inputs
  const httpProxy = core.getInput(INPUTS.httpProxy, { required: false });
  const maskPassword = (core.getInput(INPUTS.maskPassword, { required: false }).toLowerCase() || 'true') !== 'false';
  const registries = core.getInput(INPUTS.registries, { required: false });
  const registryType = core.getInput(INPUTS.registryType, { required: false }).toLowerCase() || REGISTRY_TYPES.private;
  const tokenType = core.getInput(INPUTS.tokenType, { required: false }) || TOKEN_TYPES.regional;
  const skipLogout = core.getInput(INPUTS.skipLogout, { required: false }).toLowerCase() === 'true';

  const registryUriState = [];

  try {
    if (registryType !== REGISTRY_TYPES.private && registryType !== REGISTRY_TYPES.public) {
      throw new Error(`Invalid input for '${INPUTS.registryType}', possible options are [${REGISTRY_TYPES.private}, ${REGISTRY_TYPES.public}]`);
    }
    const useGlobalToken = registryType === REGISTRY_TYPES.private &&
      tokenType === TOKEN_TYPES.global;
    if (registryType === REGISTRY_TYPES.private &&
        tokenType !== TOKEN_TYPES.regional &&
        !useGlobalToken) {
      throw new Error(`Invalid input for '${INPUTS.tokenType}', possible options are [${TOKEN_TYPES.regional}, ${TOKEN_TYPES.global}]`);
    }

    // Notify customer if they don't have their password masked
    if (!maskPassword) {
      core.warning('Your docker password is not masked. See https://github.com/aws-actions/amazon-ecr-login#docker-credentials ' +
        'for more information.')
    }

    // Configures proxy
    const httpsProxyAgent = configureProxy(httpProxy);

    // Get the ECR/ECR Public authorization token(s)
    const authTokenRequest = {};
    let registryIds = [];
    if (registryType === REGISTRY_TYPES.private && registries) {
      registryIds = registries.split(',');
      core.debug(`${useGlobalToken ? 'Preparing login for' : 'Requesting auth token for'} ${registryIds.length} registries:`);
      for (const id of registryIds) {
        core.debug(`  '${id}'`);
      }
      authTokenRequest.registryIds = registryIds;
    }
    let authTokenResponse;
    if (registryType === REGISTRY_TYPES.public) {
      authTokenResponse = await getEcrPublicAuthTokenWrapper(authTokenRequest, httpsProxyAgent);
    } else if (useGlobalToken) {
      authTokenResponse = await getEcrGlobalAuthTokenWrapper(registryIds, httpsProxyAgent);
    } else {
      authTokenResponse = await getEcrAuthTokenWrapper(authTokenRequest, httpsProxyAgent);
    }

    // Login to each registry
    for (const authData of authTokenResponse.authorizationData) {
      const creds = useGlobalToken
        ? [authData.username, authData.password]
        : Buffer.from(authData.authorizationToken, 'base64').toString('utf-8').split(':', 2);
      const proxyEndpoint = authData.proxyEndpoint;
      const registryUri = proxyEndpoint.replace(/^https?:\/\//, '');

      core.info(`Logging into registry ${registryUri}`);

      // output the registry URI if this action is doing a single registry login
      if (authTokenResponse.authorizationData.length === 1) {
        core.setOutput(OUTPUTS.registry, registryUri);
      }

      if (useGlobalToken && maskPassword) {
        core.setSecret(creds[1]);
        core.debug('Your docker password is masked.');
      }

      // Execute the docker login command
      let doLoginStdout = '';
      let doLoginStderr = '';
      const dockerArguments = useGlobalToken
        ? ['login', '-u', creds[0], '--password-stdin', proxyEndpoint]
        : ['login', '-u', creds[0], '-p', creds[1], proxyEndpoint];
      const dockerOptions = {
        silent: true,
        ignoreReturnCode: true,
        listeners: {
          stdout: (data) => {
            doLoginStdout += data.toString();
          },
          stderr: (data) => {
            doLoginStderr += data.toString();
          }
        }
      };
      if (useGlobalToken) {
        dockerOptions.input = Buffer.from(`${creds[1]}\n`);
      }
      const exitCode = await exec.exec('docker', dockerArguments, dockerOptions);
      if (exitCode !== 0) {
        core.debug(doLoginStdout);
        throw new Error(`Could not login to registry ${registryUri}: ${doLoginStderr}`);
      }

      // Output docker username and password
      const secretSuffix = replaceSpecialCharacters(registryUri);
      if (!useGlobalToken && maskPassword) {
        core.setSecret(creds[1]);
        core.debug('Your docker password is masked.');
      }
      core.setOutput(`${OUTPUTS.dockerUsername}_${secretSuffix}`, creds[0]);
      core.setOutput(`${OUTPUTS.dockerPassword}_${secretSuffix}`, creds[1]);

      registryUriState.push(registryUri);
    }
  }
  catch (error) {
    core.setFailed(error.message);
  }

  // Pass the logged-in registry URIs to the post action for logout
  if (registryUriState.length) {
    if (!skipLogout) {
      core.saveState(STATES.registries, registryUriState.join());
    }
    core.debug(`'${INPUTS.skipLogout}' is ${skipLogout} for ${registryUriState.length} registries.`);
  }
}

export {
  configureProxy,
  getCredentials,
  run,
  replaceSpecialCharacters
};

/* istanbul ignore next */
if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  run();
}
