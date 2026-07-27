const { loadEnvConfig } = require('@next/env');
const crypto = require('node:crypto');

function text(value) {
  return String(value ?? '').trim();
}

function deriveIssuer(env) {
  const base = text(env.MERGEN_ROTA_KEYCLOAK_BASE_URL).replace(/\/+$/, '');
  const realm = text(env.MERGEN_ROTA_KEYCLOAK_REALM);
  if (/\/realms\/[^/]+$/.test(base)) return base;
  if (!base || !realm) return '';
  return `${base}/realms/${encodeURIComponent(realm)}`;
}

function truncate(value, max = 300) {
  const raw = text(value);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

async function readJsonSafely(response) {
  const raw = await response.text();
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    return { json: null, raw };
  }
}

function printHeading(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function printResult(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const loaded = loadEnvConfig(process.cwd(), false);
  const env = process.env;

  const issuer = deriveIssuer(env);
  const clientId = text(env.MERGEN_ROTA_KEYCLOAK_CLIENT_ID);
  const clientSecret = text(env.MERGEN_ROTA_KEYCLOAK_CLIENT_SECRET);
  const redirectUri = text(env.MERGEN_ROTA_KEYCLOAK_REDIRECT_URI);
  const scope = text(env.MERGEN_ROTA_KEYCLOAK_SCOPE) || 'openid profile email';

  printHeading('TEST 1 — Effective configuration loaded by Next.js');
  printResult({
    workingDirectory: process.cwd(),
    loadedEnvFiles: (loaded.loadedEnvFiles || []).map((item) => item.path),
    authMode: text(env.MERGEN_ROTA_AUTH_MODE),
    issuer,
    realm: text(env.MERGEN_ROTA_KEYCLOAK_REALM),
    clientId,
    clientSecretSupplied: Boolean(clientSecret),
    redirectUri,
    postLogoutRedirectUri: text(env.MERGEN_ROTA_KEYCLOAK_POST_LOGOUT_REDIRECT_URI),
    scope,
    expectedAudience: text(env.MERGEN_ROTA_KEYCLOAK_AUDIENCE) || '(defaults to client ID)',
    expectedAuthorizedParty: text(env.MERGEN_ROTA_KEYCLOAK_AUTHORIZED_PARTY) || '(defaults to client ID)',
    sessionSecretLength: text(env.MERGEN_ROTA_SESSION_SECRET).length,
    sessionCookieSecure: text(env.MERGEN_ROTA_SESSION_COOKIE_SECURE),
    nodeExtraCaCerts: text(env.NODE_EXTRA_CA_CERTS) || '(NOT SET — must be set before Node starts)'
  });

  if (!issuer || !clientId || !redirectUri) {
    throw new Error('Required issuer/client ID/redirect URI values are missing from the effective environment.');
  }

  printHeading('TEST 2 — OIDC discovery and Node TLS trust');
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const discoveryResponse = await fetch(discoveryUrl, {
    headers: { accept: 'application/json' }
  });
  const discoveryBody = await readJsonSafely(discoveryResponse);

  printResult({
    url: discoveryUrl,
    httpStatus: discoveryResponse.status,
    issuerReturned: discoveryBody.json?.issuer || null,
    authorizationEndpoint: discoveryBody.json?.authorization_endpoint || null,
    tokenEndpoint: discoveryBody.json?.token_endpoint || null,
    codeChallengeMethodsSupported: discoveryBody.json?.code_challenge_methods_supported || null,
    responsePreview: discoveryBody.json ? null : truncate(discoveryBody.raw)
  });

  if (!discoveryResponse.ok || !discoveryBody.json) {
    throw new Error('OIDC discovery failed. Fix TLS/network/issuer before continuing.');
  }

  const authorizationEndpoint = discoveryBody.json.authorization_endpoint || `${issuer}/protocol/openid-connect/auth`;
  const tokenEndpoint = discoveryBody.json.token_endpoint || `${issuer}/protocol/openid-connect/token`;

  printHeading('TEST 3 — Authorization endpoint: client + redirect + Code Flow + PKCE S256');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: crypto.randomBytes(24).toString('base64url'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'none'
  }).toString();

  const authorizationResponse = await fetch(authorizationUrl, {
    redirect: 'manual',
    headers: { accept: 'text/html,application/xhtml+xml' }
  });

  const location = authorizationResponse.headers.get('location');
  let locationInfo = null;

  if (location) {
    const target = new URL(location, authorizationUrl);
    const callback = new URL(redirectUri);
    locationInfo = {
      target: `${target.origin}${target.pathname}`,
      returnsToConfiguredCallback: `${target.origin}${target.pathname}` === `${callback.origin}${callback.pathname}`,
      error: target.searchParams.get('error'),
      errorDescription: truncate(target.searchParams.get('error_description')),
      authorizationCodeReturned: target.searchParams.has('code')
    };
  }

  printResult({
    httpStatus: authorizationResponse.status,
    location: locationInfo,
    interpretation:
      locationInfo?.returnsToConfiguredCallback && locationInfo?.error === 'login_required'
        ? 'GOOD: Keycloak accepted the client ID, redirect URI, Authorization Code request and PKCE S256. login_required is expected because this Node request has no browser SSO cookie.'
        : locationInfo?.error === 'unauthorized_client'
          ? 'ROOT CAUSE LIKELY: this client is not allowed to use Authorization Code / Standard Flow.'
          : locationInfo?.error
            ? `KEYCLOAK REJECTED REQUEST: ${locationInfo.error}`
            : 'INCONCLUSIVE: inspect the status and redirect target above.'
  });

  printHeading('TEST 4 — Token endpoint client-authentication probe using an intentionally invalid code');
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: 'MERGEN_ROTA_DIAGNOSTIC_INVALID_CODE',
    redirect_uri: redirectUri,
    code_verifier: verifier
  });

  if (clientSecret) tokenBody.set('client_secret', clientSecret);

  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: tokenBody.toString()
  });

  const tokenPayload = await readJsonSafely(tokenResponse);
  const tokenError = tokenPayload.json?.error || null;
  const tokenErrorDescription = truncate(tokenPayload.json?.error_description);

  let tokenInterpretation = 'INCONCLUSIVE: inspect the response.';
  if (tokenError === 'invalid_grant') {
    tokenInterpretation = 'GOOD: Keycloak recognized the client and accepted the configured client authentication. invalid_grant is expected because the diagnostic code is deliberately fake. A missing client secret is therefore unlikely to be the problem.';
  } else if (tokenError === 'invalid_client') {
    tokenInterpretation = 'ROOT CAUSE LIKELY: wrong client ID, or the client is confidential and the configured secret is missing/incorrect.';
  } else if (tokenError === 'unauthorized_client') {
    tokenInterpretation = 'ROOT CAUSE LIKELY: this client is not permitted to use this grant/flow.';
  }

  printResult({
    tokenEndpoint,
    httpStatus: tokenResponse.status,
    error: tokenError,
    errorDescription: tokenErrorDescription,
    clientId,
    clientSecretSupplied: Boolean(clientSecret),
    interpretation: tokenInterpretation,
    responsePreview: tokenPayload.json ? null : truncate(tokenPayload.raw)
  });

  printHeading('TEST 5 — Optional live MERGEN Rota login route');
  const callback = new URL(redirectUri);
  const localPort = callback.port || (callback.protocol === 'https:' ? '443' : '80');
  const localScheme = callback.protocol === 'https:' ? 'https:' : 'http:';
  const localLoginUrl = `${localScheme}//127.0.0.1:${localPort}/api/mergen-rota/auth/login`;

  try {
    const liveResponse = await fetch(localLoginUrl, { redirect: 'manual' });
    const liveLocation = liveResponse.headers.get('location');
    const setCookie = liveResponse.headers.get('set-cookie') || '';
    let liveInfo = null;

    if (liveLocation) {
      const target = new URL(liveLocation);
      liveInfo = {
        targetHost: target.host,
        clientId: target.searchParams.get('client_id'),
        redirectUri: target.searchParams.get('redirect_uri'),
        responseType: target.searchParams.get('response_type'),
        pkceMethod: target.searchParams.get('code_challenge_method'),
        scope: target.searchParams.get('scope')
      };
    }

    printResult({
      url: localLoginUrl,
      httpStatus: liveResponse.status,
      authorizationRequest: liveInfo,
      transactionCookieName: setCookie ? setCookie.split('=')[0] : null,
      interpretation:
        liveInfo?.clientId === clientId &&
        liveInfo?.redirectUri === redirectUri &&
        liveInfo?.responseType === 'code' &&
        liveInfo?.pkceMethod === 'S256'
          ? 'GOOD: the running MERGEN Rota process is using the same effective client ID, redirect URI and PKCE settings.'
          : 'CHECK: the running application may be using different/stale environment values, or it is not running.'
    });
  } catch (error) {
    printResult({
      url: localLoginUrl,
      skipped: true,
      reason: `Could not reach the running application: ${error.message}`,
      note: 'Start MERGEN Rota in another CMD window and run this script again.'
    });
  }

  printHeading('SUMMARY');
  console.log([
    'Send back the complete output of TEST 3 and TEST 4.',
    'Those two results usually identify whether the problem is:',
    '  • redirect/client/Standard Flow/PKCE configuration,',
    '  • public-versus-confidential client authentication, or',
    '  • something later in the real one-time code exchange.'
  ].join('\n'));
}

main().catch((error) => {
  console.error('\nDIAGNOSTIC FAILED:', error);
  process.exitCode = 1;
});
