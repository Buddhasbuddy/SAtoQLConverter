# IIS deployment

This branch is prepared for hosting the application at:

    https://lt.saskpolytech.ca/sa-to-ql/

The recommended layout is:

    Internet / Brightspace
            |
            v
    IIS HTTPS site: lt.saskpolytech.ca
            |
            +-- /sa-to-ql  (IIS Application)
                    |
                    v
            ARR + URL Rewrite
                    |
                    v
            http://127.0.0.1:8000
                    |
                    v
            FastAPI / Uvicorn

## IIS prerequisites

The IIS server needs:

1. IIS URL Rewrite module.
2. Application Request Routing (ARR).
3. ARR proxying enabled at the server level.
4. Python 3.11+ installed for the application service account.
5. A valid HTTPS certificate already bound to lt.saskpolytech.ca.

In IIS Manager, enable ARR proxying:

    Server
      > Application Request Routing Cache
      > Server Proxy Settings
      > Enable proxy

## Suggested server folder

Example:

    C:\\inetpub\\apps\\SAtoQLConverter

Clone or copy the server-integration branch there.

## Create the Python environment

From PowerShell:

    cd C:\\inetpub\\apps\\SAtoQLConverter
    py -3.11 -m venv .venv
    .\\.venv\\Scripts\\Activate.ps1
    python -m pip install --upgrade pip
    pip install -r .\\server\\requirements.txt

## Environment variables

Configure these as machine/service environment variables. Do not commit real LTI secrets to GitHub.

    APP_BASE_URL=https://lt.saskpolytech.ca/sa-to-ql
    BRIGHTSPACE_BASE_URL=
    BRIGHTSPACE_LE_VERSION=
    LTI_CLIENT_ID=
    LTI_DEPLOYMENT_ID=
    LTI_ISSUER=
    LTI_PLATFORM_JWKS_URL=
    LTI_PLATFORM_AUTH_URL=
    LTI_PLATFORM_TOKEN_URL=
    LTI_STATE_SECRET=<long-random-secret>

Generate LTI_STATE_SECRET with PowerShell, for example:

    $bytes = New-Object byte[] 48
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToBase64String($bytes)

## Test FastAPI directly

Run:

    .\\deploy\\iis\\start-sa-to-ql.ps1

Then, on the server itself, browse to:

    http://127.0.0.1:8000/api/health

Expected response:

    {"status":"ok","service":"Brightspace Self-Assessment to Question Library Converter"}

## Create the IIS application

In IIS Manager:

1. Locate the HTTPS site serving lt.saskpolytech.ca.
2. Add an application named sa-to-ql.
3. Point the application's physical path to:

       C:\\inetpub\\apps\\SAtoQLConverter\\deploy\\iis

4. Use an application pool with No Managed Code.
5. Confirm web.config is present in that folder.

The included deploy/iis/web.config proxies all requests in the /sa-to-ql IIS application to FastAPI on 127.0.0.1:8000.

Because this is configured as an IIS Application, the external prefix /sa-to-ql is removed before the request is proxied. For example:

    https://lt.saskpolytech.ca/sa-to-ql/api/health

is proxied internally as:

    http://127.0.0.1:8000/api/health

## Keep Uvicorn running

For an initial test, running the PowerShell startup script interactively is fine.

For production, run Uvicorn under a Windows service wrapper or your organization's standard Windows service-management process. The important properties are:

    Working directory:
    C:\\inetpub\\apps\\SAtoQLConverter

    Command:
    C:\\inetpub\\apps\\SAtoQLConverter\\.venv\\Scripts\\python.exe

    Arguments:
    -m uvicorn server.app:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips 127.0.0.1

The FastAPI listener should stay bound only to 127.0.0.1; IIS remains the public HTTPS endpoint.

## External checks

Once IIS proxying and Uvicorn are both running, test:

    https://lt.saskpolytech.ca/sa-to-ql/api/health
    https://lt.saskpolytech.ca/sa-to-ql/api/capabilities
    https://lt.saskpolytech.ca/sa-to-ql/

The first should return the health JSON, the second should return the current integration capabilities, and the third should display the converter.

## Brightspace LTI tool URLs

After the hosted application passes the external tests, use:

    OpenID Connect Login URL:
    https://lt.saskpolytech.ca/sa-to-ql/lti/login

    Redirect URL:
    https://lt.saskpolytech.ca/sa-to-ql/lti/launch

Do not register the GitHub Pages URL for the LTI version.

## Troubleshooting

### HTTP 502 from IIS

Uvicorn is not running, is listening on a different port, or ARR cannot reach 127.0.0.1:8000.

### HTTP 500.52 / rewrite errors

Confirm IIS URL Rewrite is installed and ARR proxying is enabled.

### Application works at localhost but CSS is missing externally

Confirm the IIS application is named exactly sa-to-ql and APP_BASE_URL=https://lt.saskpolytech.ca/sa-to-ql.

### LTI redirects to the wrong path

Confirm APP_BASE_URL does not contain a trailing slash and restart the FastAPI service after changing environment variables.
