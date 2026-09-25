from __future__ import annotations

import html
import io
import os
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    StreamingResponse,
)

from .converter import ConversionError, convert_uploads
from .lti import (
    LtiConfigurationError,
    LtiLaunchError,
    create_login_redirect,
    validate_launch,
)

APP_NAME = "Brightspace Self-Assessment to Question Library Converter"
OUTPUT_NAME = "Brightspace_QuestionLibrary_Migration.zip"
REPO_ROOT = Path(__file__).resolve().parents[1]
APP_BASE_URL = os.getenv("APP_BASE_URL", "").rstrip("/")

def public_url(path: str) -> str:
    if APP_BASE_URL:
        return f"{APP_BASE_URL}/{path.lstrip('/')}"
    return f"/{path.lstrip('/')}"

app = FastAPI(
    title=APP_NAME,
    version="0.2.0",
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": APP_NAME}


@app.get("/api/capabilities")
async def capabilities() -> dict:
    """
    Makes the current integration boundary explicit to the UI.

    The server-side converter and documented Brightspace package-import API
    are available. Direct Self-Assessment discovery is intentionally marked
    unavailable until we have a supported Brightspace source mechanism.
    """
    return {
        "serverConversion": True,
        "brightspacePackageImport": True,
        "ltiCourseContext": True,
        "directSelfAssessmentDiscovery": False,
    }




@app.api_route("/lti/login", methods=["GET", "POST"])
async def lti_login(request: Request):
    if request.method == "POST":
        form = await request.form()
        params = {key: str(value) for key, value in form.items()}
    else:
        params = dict(request.query_params)

    try:
        redirect_url = create_login_redirect(params)
    except (LtiConfigurationError, LtiLaunchError) as exc:
        return HTMLResponse(
            f"<h1>LTI launch could not start</h1>"
            f"<p>{html.escape(str(exc))}</p>",
            status_code=400,
        )

    return RedirectResponse(redirect_url, status_code=302)


@app.post("/lti/launch")
async def lti_launch(request: Request):
    form = await request.form()
    id_token = str(form.get("id_token") or "")
    state = str(form.get("state") or "")

    if not id_token or not state:
        return HTMLResponse(
            "<h1>LTI launch failed</h1>"
            "<p>The Brightspace launch did not include id_token and state.</p>",
            status_code=400,
        )

    try:
        context = await validate_launch(id_token=id_token, state=state)
    except (LtiConfigurationError, LtiLaunchError) as exc:
        return HTMLResponse(
            f"<h1>LTI launch failed</h1>"
            f"<p>{html.escape(str(exc))}</p>",
            status_code=400,
        )

    possible_org_unit = context.possible_org_unit_id
    course_id_display = possible_org_unit or context.context_id or "Not supplied"

    return HTMLResponse(
        f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Self-Assessment Migration</title>
  <link rel="stylesheet" href="{html.escape(public_url('style.css'))}">
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Brightspace LTI launch</p>
        <h1>Self-Assessment Migration</h1>
        <p class="lede">The hosted application successfully validated the Brightspace LTI 1.3 launch.</p>
      </div>
      <span class="badge">Course context received</span>
    </header>

    <section class="panel">
      <h2>{html.escape(context.context_title)}</h2>
      <p><strong>Course/context ID:</strong> {html.escape(course_id_display)}</p>
      <p><strong>Signed-in user:</strong> {html.escape(context.name)}</p>
      <p class="note">
        Direct Self-Assessment discovery is the next integration step. The application
        will not use an undocumented Brightspace endpoint for production access.
      </p>
    </section>
  </main>
</body>
</html>"""
    )


@app.post("/api/convert")
async def convert(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No files were supplied.")

    uploads: list[tuple[str, bytes]] = []
    for upload in files:
        name = upload.filename or "upload"
        data = await upload.read()
        if not data:
            raise HTTPException(
                status_code=400,
                detail=f"{name} is empty.",
            )
        uploads.append((name, data))

    try:
        result = convert_uploads(uploads)
    except ConversionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    headers = {
        "Content-Disposition": f'attachment; filename="{OUTPUT_NAME}"',
        "X-SAQL-Assessment-Count": str(len(result.report)),
        "X-SAQL-Question-Count": str(
            sum(item["questionCount"] for item in result.report)
        ),
    }

    return StreamingResponse(
        io.BytesIO(result.package_bytes),
        media_type="application/zip",
        headers=headers,
    )


# During the transition from GitHub Pages, serve the existing front end from
# explicit paths. This avoids exposing the server source directory.
@app.get("/")
async def index():
    return FileResponse(REPO_ROOT / "index.html")


@app.get("/index.html")
async def index_html():
    return FileResponse(REPO_ROOT / "index.html")


@app.get("/style.css")
async def style():
    return FileResponse(REPO_ROOT / "style.css", media_type="text/css")


@app.get("/script.js")
async def script():
    return FileResponse(
        REPO_ROOT / "script.js",
        media_type="application/javascript",
    )


@app.exception_handler(ConversionError)
async def conversion_error_handler(_, exc: ConversionError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})
