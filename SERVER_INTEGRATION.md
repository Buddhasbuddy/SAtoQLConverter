# Server integration roadmap

The GitHub Pages converter remains the working browser prototype. The
`server-integration` branch adds a server-hosted foundation without removing
or changing the current static application.

## What is implemented now

- FastAPI application in `server/app.py`.
- Server-side Brightspace Self-Assessment to Question Library conversion in
  `server/converter.py`.
- `POST /api/convert` accepts either:
  - one Brightspace export ZIP; or
  - one or more `selfassess_d2l_*.xml` files.
- The server creates a ZIP containing only:
  - `imsmanifest.xml`
  - `questiondb.xml`
- Existing local `src` and `href` values are preserved. Course media is
  intentionally not repackaged because the package is intended for the same
  course.
- `server/brightspace.py` contains a client for Brightspace's documented
  course-import job API.
- `server/lti.py` implements the initial LTI 1.3 OIDC login flow and validates
  Brightspace's signed launch token against the platform JWKS.
- `/lti/login` and `/lti/launch` are now available for a Brightspace test
  registration. A successful launch displays the signed-in user and course
  context received from Brightspace.

## Run locally

From the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1

pip install -r server/requirements.txt
uvicorn server.app:app --reload
```

Open:

```text
http://127.0.0.1:8000/
```

Health check:

```text
http://127.0.0.1:8000/api/health
```

## Current Brightspace integration boundary

D2L's current LTI 1.3 documentation confirms that an LTI launch can provide
the external tool with user role and course context. A registered tool uses
OIDC/JWT for launch authentication.

D2L also documents a course import API:

```text
POST /d2l/api/le/{version}/import/{orgUnitId}/imports/
```

with OAuth2 scope:

```text
import:job:create
```

and import-job status retrieval with:

```text
GET /d2l/api/le/{version}/import/{orgUnitId}/imports/{jobToken}
```

using:

```text
import:job:fetch
```

This means the generated Question Library package can ultimately be submitted
directly back to the current course once the application has an authorized
Brightspace access token.

## Still unresolved

We do not yet have a documented public Brightspace API route that provides the
complete existing Self-Assessment question XML needed by this converter.

Do not work around that gap by using an unverified internal Brightspace
endpoint in production.

The next integration milestone is therefore:

1. Deploy this branch to the hosted test server over HTTPS.
2. Register `/lti/login` as the OpenID Connect Login URL and `/lti/launch` as
   the Redirect URL in a Brightspace LTI 1.3 test registration.
3. Confirm a launch validates successfully and inspect the course context.
4. Determine the supported source mechanism for enumerating and retrieving
   Self-Assessments from that course.
5. Feed those source questions into the existing converter.
6. Submit the generated package directly to the same course through the
   documented course-import job API.

## D2L references

- LTI launch/authentication:
  https://community.d2l.com/brightspace/kb/articles/23730-about-lti-1-3-launch-and-authentication
- LTI Advantage:
  https://community.d2l.com/brightspace/kb/articles/23660-lti-advantage-v1-3
- Course import API:
  https://docs.valence.desire2learn.com/res/course.html
- File upload convention:
  https://docs.valence.desire2learn.com/basic/fileupload.html

## LTI test configuration

Set these environment variables before testing a launch:

```text
APP_BASE_URL=https://lt.saskpolytech.ca/sa-to-ql
LTI_CLIENT_ID=<Brightspace registration client ID>
LTI_DEPLOYMENT_ID=<Brightspace deployment ID>
LTI_ISSUER=<issuer shown by Brightspace>
LTI_PLATFORM_JWKS_URL=<Brightspace keyset URL>
LTI_PLATFORM_AUTH_URL=<Brightspace OpenID Connect authentication endpoint>
LTI_STATE_SECRET=<long random value>
```

For the Brightspace registration, the tool-side URLs are:

```text
OpenID Connect Login URL: https://lt.saskpolytech.ca/sa-to-ql/lti/login
Redirect URL:             https://lt.saskpolytech.ca/sa-to-ql/lti/launch
```

The basic launch implementation does not yet request Names and Roles or
Assignment and Grade Services. It only validates the launch and captures
course/user context. This keeps the first integration test narrow.
